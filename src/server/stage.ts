import * as fs from 'fs';
import { StageState, VideoItem, MAX_FADE_SECONDS, clamp } from '../shared/types';
import { ServerContext } from './context';

type CmdResult = { ok: boolean; error?: string; needConfirm?: boolean };

/**
 * Контроллер сценического вывода.
 * Хранит состояние сцены, координирует: окно Stage Output (через ElectronBridge),
 * страницу сценического вывода (через WS target='stage') и веб/десктоп UI.
 *
 * Принципы:
 *  - если выбранный дисплей недоступен — воспроизведение не запускается,
 *    пользователю предлагается подтверждение вывода на основной экран;
 *  - при отключении монитора (событие Electron) вывод безопасно возвращается
 *    на основной дисплей;
 *  - команды выполняются только после подтверждения сервером.
 */
export class StageController {
  constructor(private ctx: ServerContext) {}

  private get s(): StageState {
    return this.ctx.store.stage;
  }

  private broadcast(): void {
    this.ctx.broadcastSnapshot();
  }

  private fwd(action: string, payload?: unknown): void {
    this.ctx.ws.sendToRoles(['stage'], { type: 'command', target: 'stage', domain: 'stage', action, payload });
  }

  /** Отчёт со страницы сценического вывода (позиция, статус). */
  report(data: Record<string, unknown>): void {
    let changed = false;
    if (typeof data.status === 'string' && data.status !== this.s.status) { this.s.status = data.status as StageState['status']; changed = true; }
    if (typeof data.position === 'number') { this.s.position = data.position; changed = true; }
    if (typeof data.duration === 'number' && data.duration > 0) { this.s.duration = data.duration; changed = true; }
    if (typeof data.blacked === 'boolean' && data.blacked !== this.s.blacked) { this.s.blacked = data.blacked; changed = true; }
    if (typeof data.activeFade === 'string' || data.activeFade === null) {
      const f = (data.activeFade as StageState['activeFade']) ?? null;
      if (f !== this.s.activeFade) { this.s.activeFade = f; changed = true; }
    }
    // Ролик завершился: id приходит строкой (uuid) или числом — принимаем оба варианта
    if (data.ended !== undefined && data.ended !== null && data.ended !== false && data.ended !== '') {
      this.handleEnded(String(data.ended));
      return;
    }
    if (changed) this.broadcast();
  }

  /** Естественное окончание ролика: обрабатываем afterAction. */
  private handleEnded(videoId: string): void {
    const item = this.ctx.videos.byId(videoId);
    this.ctx.log.info(`Сцена: ролик завершился (${item?.title || videoId})`);
    if (!item) { this.stopNow(); return; }
    if (item.repeat) {
      this.fwd('load', { videoId: item.id, autoplay: true });
      return;
    }
    switch (item.afterAction) {
      case 'loop': {
        // зациклить плейлист
        if (this.s.playlist.length > 1) {
          const nextId = this.s.playlist[0];
          this.loadVideo(nextId, true);
        } else {
          this.fwd('load', { videoId: item.id, autoplay: true });
        }
        break;
      }
      case 'next': {
        const next = this.nextVideoId(item);
        if (next) this.loadVideo(next, true);
        else this.stopWithBehavior(item);
        break;
      }
      case 'black': {
        this.fwd('fadeOutThenBlack', { duration: item.fadeOut });
        this.s.status = 'stopped';
        this.broadcast();
        break;
      }
      case 'stop':
      default:
        this.stopWithBehavior(item);
    }
  }

  private stopNow(): void {
    this.fwd('stopNow');
    this.s.status = 'stopped';
    this.s.position = 0;
    this.broadcast();
  }

  private stopWithBehavior(item: VideoItem): void {
    if (item.stopBehavior === 'freeze') {
      this.fwd('freeze');
      this.s.status = 'stopped';
    } else {
      this.fwd('fadeOutThenBlack', { duration: item.fadeOut });
      this.s.status = 'stopped';
    }
    this.broadcast();
  }

  private nextVideoId(item: VideoItem): string | null {
    if (item.nextVideoId && this.ctx.videos.byId(item.nextVideoId)) return item.nextVideoId;
    if (this.s.playlist.length > 0 && this.s.playlistIndex >= 0 && this.s.playlistIndex < this.s.playlist.length - 1) {
      return this.s.playlist[this.s.playlistIndex + 1];
    }
    return null;
  }

  /**
   * Определяем целевой дисплей. Возвращает:
   *  - { ok: true } — дисплей готов;
   *  - { ok: false, needConfirm: true } — нужен выбор/подтверждение пользователем;
   *  - { ok: false, error } — воспроизведение невозможно.
   */
  private resolveTargetDisplay(): CmdResult {
    const bridge = this.ctx.bridge;
    if (!bridge || !bridge.electronAvailable) {
      return { ok: false, error: 'Сценический вывод доступен только в приложении Sonic Studio на компьютере (Electron).' };
    }
    const displays = bridge.getDisplays();
    if (displays.length === 0) {
      return { ok: false, error: 'Дисплеи не обнаружены. Нажмите «Обновить дисплеи».' };
    }
    const wantId = this.s.displayId ?? this.ctx.settings.data.stageDisplayId ?? null;
    if (wantId === null) {
      if (displays.length === 1) {
        const d = displays[0];
        this.s.displayId = d.id;
        const mv = bridge.moveStageToDisplay(d.id);
        return mv.ok ? { ok: true } : { ok: false, error: mv.error || 'Не удалось переместить окно вывода' };
      }
      this.s.pendingDisplayId = displays[0].id;
      this.broadcast();
      return { ok: false, needConfirm: true, error: 'Выберите экран для сценического вывода' };
    }
    const target = displays.find(d => d.id === wantId);
    if (!target) {
      this.s.pendingDisplayId = wantId;
      this.broadcast();
      return { ok: false, needConfirm: true, error: 'Выбранный дисплей недоступен. Вывести на основной экран?' };
    }
    const mv = bridge.moveStageToDisplay(target.id);
    if (!mv.ok) return { ok: false, error: mv.error || 'Не удалось переместить окно вывода на выбранный дисплей' };
    this.s.displayId = target.id;
    return { ok: true };
  }

  private loadVideo(videoId: string, autoplay: boolean): CmdResult {
    const item = this.ctx.videos.byId(videoId);
    if (!item) return { ok: false, error: 'Видео не найдено в библиотеке' };
    if (item.missing || !fs.existsSync(item.path)) {
      this.ctx.videos.updateSettings(videoId, { missing: true });
      this.ctx.store.touch('videos');
      return { ok: false, error: 'Файл видео не найден. Возможно, он был перемещён или удалён.' };
    }
    // открываем окно вывода, если закрыто
    const bridge = this.ctx.bridge;
    if (bridge && bridge.electronAvailable && !bridge.isStageWindowOpen()) {
      bridge.openStageWindow();
    }
    this.s.videoId = item.id;
    this.s.videoTitle = item.title;
    this.s.imageId = null;
    this.s.imageTitle = '';
    this.s.duration = item.duration;
    this.s.position = item.startPosition || 0;
    this.s.volume = item.volume;
    this.s.muted = item.muted;
    this.s.fadeIn = clampFadeVal(item.fadeIn);
    this.s.fadeOut = clampFadeVal(item.fadeOut);
    this.s.blacked = false;
    this.s.error = null;
    if (this.s.playlist.includes(item.id)) {
      this.s.playlistIndex = this.s.playlist.indexOf(item.id);
    }
    const idx = this.s.playlist.indexOf(item.id);
    const nextId = idx >= 0 && idx < this.s.playlist.length - 1 ? this.s.playlist[idx + 1] : (item.nextVideoId || '');
    this.s.nextVideoTitle = nextId ? (this.ctx.videos.byId(nextId)?.title || '') : '';
    this.fwd('load', {
      videoId: item.id,
      autoplay,
      item: {
        volume: item.volume, muted: item.muted, startPosition: item.startPosition,
        endPosition: item.endPosition ?? null, repeat: item.repeat,
        fadeIn: item.fadeIn, fadeOut: item.fadeOut
      }
    });
    if (!autoplay) this.s.status = 'paused';
    this.broadcast();
    this.ctx.videos.addHistory(item);
    this.ctx.store.touch('history');
    return { ok: true };
  }

  /** Главная точка входа: команда с UI (десктоп или телефон). */
  async command(action: string, payload: Record<string, unknown> = {}): Promise<CmdResult> {
    const s = this.s;
    switch (action) {
      case 'load': {
        const id = String(payload.videoId || '');
        const r = this.resolveTargetDisplay();
        if (!r.ok) return r;
        return this.loadVideo(id, payload.autoplay !== false);
      }
      case 'play': {
        if (!s.videoId) return { ok: false, error: 'Сначала выберите видео для сценического вывода' };
        const r = this.resolveTargetDisplay();
        if (!r.ok) return r;
        this.fwd('play');
        s.status = 'playing';
        s.blacked = false;
        this.broadcast();
        return { ok: true };
      }
      case 'pause':
        this.fwd('pause');
        s.status = 'paused';
        this.broadcast();
        return { ok: true };
      case 'resume':
        this.fwd('resume');
        s.status = 'playing';
        this.broadcast();
        return { ok: true };
      case 'toggle':
        return this.command(s.status === 'playing' ? 'pause' : 'resume');
      case 'stop': {
        // мгновенная остановка + безопасный чёрный экран
        this.fwd('stopNow');
        s.status = 'stopped';
        s.position = 0;
        this.broadcast();
        return { ok: true };
      }
      case 'seek': {
        const t = Number(payload.time);
        if (!isFinite(t)) return { ok: false, error: 'Некорректное время перемотки' };
        this.fwd('seek', { time: clamp(t, 0, 1e7) });
        s.position = t;
        this.broadcast();
        return { ok: true };
      }
      case 'prev': {
        const id = s.playlistIndex > 0 ? s.playlist[s.playlistIndex - 1] : null;
        if (!id) return { ok: false, error: 'Это первый ролик в плейлисте' };
        return this.loadVideo(id, true);
      }
      case 'next': {
        const item = s.videoId ? this.ctx.videos.byId(s.videoId) : null;
        const id = item ? this.nextVideoId(item) : (s.playlist[s.playlistIndex + 1] || null);
        if (!id) return { ok: false, error: 'Это последний ролик в плейлисте' };
        return this.loadVideo(id, true);
      }
      case 'black': {
        this.fwd('black');
        s.blacked = true;
        if (s.status === 'playing') s.status = 'paused';
        this.broadcast();
        return { ok: true };
      }
      case 'restore': {
        this.fwd('restore');
        s.blacked = false;
        this.broadcast();
        return { ok: true };
      }
      case 'fadeIn': {
        const item = s.videoId ? this.ctx.videos.byId(s.videoId) : null;
        const dur = typeof payload.duration === 'number' ? payload.duration : (item?.fadeIn ?? 0);
        this.fwd('fadeIn', { duration: clampFadeVal(dur) });
        s.activeFade = 'in';
        this.broadcast();
        return { ok: true };
      }
      case 'fadeOut': {
        const item = s.videoId ? this.ctx.videos.byId(s.videoId) : null;
        const dur = typeof payload.duration === 'number' ? payload.duration : (item?.fadeOut ?? 0);
        this.fwd('fadeOut', { duration: clampFadeVal(dur) });
        s.activeFade = 'out';
        this.broadcast();
        return { ok: true };
      }
      case 'showSplash': {
        this.fwd('showSplash');
        s.splash = true;
        this.broadcast();
        return { ok: true };
      }
      case 'showText': {
        const text = String(payload.text || '').slice(0, 300);
        this.fwd('showText', { text });
        return { ok: true };
      }
      case 'hideText': {
        this.fwd('hideText');
        return { ok: true };
      }
      case 'showImage': {
        const id = String(payload.imageId || '');
        const img = this.ctx.images.byId(id);
        if (!img) return { ok: false, error: 'Картинка не найдена в библиотеке' };
        if (img.missing || !fs.existsSync(img.path)) {
          return { ok: false, error: 'Файл картинки не найден. Обновите список картинок.' };
        }
        const bridge = this.ctx.bridge;
        if (bridge && bridge.electronAvailable && !bridge.isStageWindowOpen()) {
          bridge.openStageWindow();
        }
        this.s.imageId = img.id;
        this.s.imageTitle = img.title;
        this.s.blacked = false;
        this.s.error = null;
        this.fwd('showImage', { imageId: img.id });
        this.s.status = 'stopped';
        this.s.position = 0;
        this.broadcast();
        return { ok: true };
      }
      case 'hideImage': {
        if (!this.s.imageId) return { ok: false, error: 'Картинка сейчас не показана' };
        this.fwd('hideImage');
        this.s.imageId = null;
        this.s.imageTitle = '';
        this.s.blacked = true;
        this.s.status = 'stopped';
        this.broadcast();
        return { ok: true };
      }
      case 'setVolume': {
        const v = clamp(Number(payload.volume), 0, 1);
        s.volume = v;
        this.fwd('setVolume', { volume: v });
        if (s.videoId) this.ctx.videos.updateSettings(s.videoId, { volume: v });
        this.broadcast();
        return { ok: true };
      }
      case 'setMuted': {
        const m = Boolean(payload.muted);
        s.muted = m;
        this.fwd('setMuted', { muted: m });
        if (s.videoId) this.ctx.videos.updateSettings(s.videoId, { muted: m });
        this.broadcast();
        return { ok: true };
      }
      case 'setRepeat': {
        s.repeat = Boolean(payload.repeat);
        this.fwd('setRepeat', { repeat: s.repeat });
        this.broadcast();
        return { ok: true };
      }
      case 'setPlaylist': {
        const ids = Array.isArray(payload.videoIds) ? payload.videoIds.map(String) : [];
        const valid = ids.filter(id => this.ctx.videos.byId(id));
        s.playlist = valid;
        s.playlistIndex = valid.length > 0 ? 0 : -1;
        this.broadcast();
        return { ok: true };
      }
      case 'setDisplay': {
        if (!this.ctx.bridge) return { ok: false, error: 'Выбор дисплея доступен только в приложении на компьютере' };
        const id = payload.displayId === null ? null : Number(payload.displayId);
        s.displayId = id;
        this.ctx.settings.update(d => { d.stageDisplayId = id; });
        this.ctx.store.touch('settings');
        const displays = this.ctx.bridge.getDisplays();
        const target = displays.find(d => d.id === id);
        if (target) {
          const mv = this.ctx.bridge.moveStageToDisplay(target.id);
          s.pendingDisplayId = null;
          if (!mv.ok) {
            this.broadcast();
            return { ok: false, error: mv.error || 'Не удалось переместить окно вывода' };
          }
        }
        this.broadcast();
        return { ok: true };
      }
      case 'confirmDisplay': {
        // Пользователь подтвердил вывод на предложенный (основной) экран
        if (!this.ctx.bridge) return { ok: false, error: 'Недоступно без Electron' };
        const displays = this.ctx.bridge.getDisplays();
        const accept = payload.accept !== false;
        const wanted = s.pendingDisplayId;
        s.pendingDisplayId = null;
        if (!accept) { this.broadcast(); return { ok: true }; }
        const target = displays.find(d => d.id === wanted) || displays[0];
        if (!target) return { ok: false, error: 'Дисплеи не обнаружены' };
        const mv = this.ctx.bridge.moveStageToDisplay(target.id);
        if (!mv.ok) { this.broadcast(); return { ok: false, error: mv.error || 'Не удалось переместить окно вывода' }; }
        s.displayId = target.id;
        this.ctx.settings.update(d => { d.stageDisplayId = target.id; });
        if (s.videoId) {
          this.fwd('play');
          s.status = 'playing';
        }
        this.broadcast();
        return { ok: true };
      }
      case 'fullscreen': {
        if (!this.ctx.bridge) return { ok: false, error: 'Недоступно без Electron' };
        const on = payload.on !== undefined ? Boolean(payload.on) : !this.ctx.bridge.isStageFullscreen();
        if (!this.ctx.bridge.isStageWindowOpen()) this.ctx.bridge.openStageWindow();
        this.ctx.bridge.setStageFullscreen(on);
        s.fullscreen = on;
        this.broadcast();
        return { ok: true };
      }
      case 'openWindow': {
        if (!this.ctx.bridge) return { ok: false, error: 'Недоступно без Electron' };
        this.ctx.bridge.openStageWindow();
        s.windowOpen = true;
        this.broadcast();
        return { ok: true };
      }
      case 'closeWindow': {
        if (!this.ctx.bridge) return { ok: false, error: 'Недоступно без Electron' };
        this.ctx.bridge.closeStageWindow();
        s.windowOpen = false;
        s.fullscreen = false;
        this.broadcast();
        return { ok: true };
      }
      case 'refreshDisplays': {
        if (!this.ctx.bridge) return { ok: false, error: 'Недоступно без Electron' };
        this.ctx.store.displays = this.ctx.bridge.refreshDisplays();
        this.broadcast();
        return { ok: true };
      }
      case 'crossfadeTo': {
        const id = String(payload.videoId || '');
        const item = this.ctx.videos.byId(id);
        if (!item) return { ok: false, error: 'Видео не найдено' };
        if (!this.ctx.settings.data.crossfade.enabled) {
          return this.loadVideo(id, true);
        }
        const r = this.resolveTargetDisplay();
        if (!r.ok) return r;
        const dur = clamp(Number(payload.duration ?? this.ctx.settings.data.crossfade.duration), 0.5, MAX_FADE_SECONDS);
        this.fwd('crossfade', { videoId: id, duration: dur, volume: item.volume, muted: item.muted });
        s.videoId = item.id;
        s.videoTitle = item.title;
        s.imageId = null;
        s.imageTitle = '';
        s.status = 'playing';
        this.broadcast();
        this.ctx.videos.addHistory(item);
        this.ctx.store.touch('history');
        return { ok: true };
      }
      default:
        return { ok: false, error: `Неизвестная команда сцены: ${action}` };
    }
  }

  /** Событие от main-процесса: дисплей отключён. */
  onDisplayRemoved(): void {
    const bridge = this.ctx.bridge;
    if (!bridge) return;
    const displays = bridge.refreshDisplays();
    this.ctx.store.displays = displays;
    const s = this.s;
    if (s.displayId !== null && !displays.some(d => d.id === s.displayId)) {
      const primary = displays.find(d => d.primary) || displays[0];
      if (primary) {
        // Аварийный возврат на основной экран — разрешён при отключении монитора
        bridge.moveStageToDisplay(primary.id);
        bridge.setStageFullscreen(false);
        s.displayId = primary.id;
        s.fullscreen = false;
        this.ctx.toast('error', 'Дисплей отключён. Сценический вывод перемещён на основной экран.');
        this.ctx.log.warn(`Дисплей ${s.displayId} отключён — окно вывода перемещено на основной экран`);
      } else {
        s.error = 'Все дисплеи отключены';
      }
    }
    this.broadcast();
  }

  onDisplaysChanged(): void {
    if (this.ctx.bridge) {
      this.ctx.store.displays = this.ctx.bridge.refreshDisplays();
      this.broadcast();
    }
  }

  onStageWindowClosed(): void {
    this.s.windowOpen = false;
    this.s.fullscreen = false;
    this.s.status = 'stopped';
    this.broadcast();
  }

  /** Обновляем настройки ролика «на лету», если он сейчас на сцене. */
  onVideoSettingsChanged(item: VideoItem): void {
    if (this.s.videoId !== item.id) return;
    this.s.fadeIn = clampFadeVal(item.fadeIn);
    this.s.fadeOut = clampFadeVal(item.fadeOut);
    this.fwd('applySettings', {
      volume: item.volume, muted: item.muted, fadeIn: item.fadeIn, fadeOut: item.fadeOut,
      endPosition: item.endPosition ?? null, repeat: item.repeat
    });
    this.broadcast();
  }
}

function clampFadeVal(v: number): number {
  if (!isFinite(v)) return 0;
  return clamp(v, 0, MAX_FADE_SECONDS);
}
