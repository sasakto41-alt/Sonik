import express from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { ServerContext } from './context';
import { ah, fail, sanitizeFileName, extOf } from './util';
import { streamChecked } from './media';
import { systemInfo, playerCommand } from './routes-core';
import { clamp, clampFade, MAX_FADE_SECONDS, VideoAfterAction, SoundMode } from '../shared/types';

/**
 * Маршруты: видео, плейлисты видео, сценический вывод, soundboard,
 * эквалайзер, настройки, система, аудиоредактор.
 */
export function registerExtraRoutes(app: express.Express, ctx: ServerContext): void {

  // ─── Видео ───

  app.get('/api/videos', ah(async (req, res) => {
    const videos = ctx.videos.list({
      search: typeof req.query.search === 'string' ? req.query.search : undefined,
      sort: typeof req.query.sort === 'string' ? req.query.sort : undefined,
      order: typeof req.query.order === 'string' ? req.query.order : undefined
    });
    res.json({ videos, total: videos.length });
  }));

  app.post('/api/videos/files', express.json({ limit: '1mb' }), ah(async (req, res) => {
    const pathsList = (req.body as { paths?: unknown })?.paths;
    if (!Array.isArray(pathsList)) return fail(res, 400, 'Не передан список файлов');
    const r = ctx.videos.addFiles(pathsList.map(String));
    ctx.store.touch('videos');
    ctx.broadcastSnapshot();
    res.json({ ok: true, ...r });
  }));

  app.post('/api/videos/scan', express.json({ limit: '64kb' }), ah(async (req, res) => {
    const folders = Array.isArray((req.body as { folders?: unknown })?.folders)
      ? (req.body as { folders: string[] }).folders.map(String)
      : ctx.settings.data.videoFolders;
    if (ctx.store.scan.active) return fail(res, 409, 'Сканирование уже выполняется, подождите');
    startVideoScan(ctx, folders);
    res.json({ ok: true });
  }));

  app.put('/api/videos/:id/settings', express.json({ limit: '64kb' }), ah(async (req, res) => {
    const patch = sanitizeVideoPatch(req.body as Record<string, unknown>);
    const v = ctx.videos.updateSettings(req.params.id, patch);
    if (!v) return fail(res, 404, 'Видео не найдено');
    ctx.stage.onVideoSettingsChanged(v);
    ctx.broadcastSnapshot();
    res.json({ ok: true, video: v });
  }));

  app.post('/api/videos/:id/progress', express.json({ limit: '16kb' }), ah(async (req, res) => {
    const pos = Number((req.body as { position?: unknown })?.position);
    if (!isFinite(pos)) return fail(res, 400, 'Некорректная позиция');
    const v = ctx.videos.updateSettings(req.params.id, { lastPosition: clamp(pos, 0, 1e7) });
    if (!v) return fail(res, 404, 'Видео не найдено');
    res.json({ ok: true });
  }));

  app.post('/api/videos/:id/history', ah(async (req, res) => {
    const v = ctx.videos.byId(req.params.id);
    if (!v) return fail(res, 404, 'Видео не найдено');
    ctx.videos.addHistory(v);
    ctx.store.touch('history');
    res.json({ ok: true });
  }));

  app.get('/api/videos/history', ah(async (_req, res) => {
    res.json({ items: ctx.videos.getHistory() });
  }));

  app.delete('/api/videos/:id', ah(async (req, res) => {
    const ok = ctx.videos.remove(req.params.id);
    if (!ok) return fail(res, 404, 'Видео не найдено');
    ctx.store.touch('videos');
    ctx.broadcastSnapshot();
    res.json({ ok: true });
  }));

  app.get('/api/videos/thumb/:id', ah(async (req, res) => {
    const v = ctx.videos.byId(req.params.id);
    if (!v || !v.thumbFile) return res.status(404).json({ error: 'Миниатюра ещё не создана' });
    streamChecked(req, res, [ctx.paths.thumbs], path.join(ctx.paths.thumbs, path.basename(v.thumbFile)));
  }));

  /** Загрузка миниатюры (renderer кадрирует видео в canvas и отправляет JPEG). */
  app.post('/api/videos/:id/thumb', express.raw({ type: () => true, limit: '12mb' }), ah(async (req, res) => {
    const v = ctx.videos.byId(req.params.id);
    if (!v) return fail(res, 404, 'Видео не найдено');
    const buf = req.body as Buffer;
    if (!buf || buf.length < 100) return fail(res, 400, 'Пустая миниатюра');
    const name = `thumb-${v.id}.jpg`;
    fs.writeFileSync(path.join(ctx.paths.thumbs, name), buf);
    ctx.videos.setThumbFile(v.id, name);
    ctx.store.touch('videos');
    ctx.broadcastSnapshot();
    res.json({ ok: true });
  }));

  // ─── Плейлисты видео ───

  app.get('/api/video-playlists', ah(async (_req, res) => {
    res.json({ playlists: ctx.playlists.listVideo() });
  }));

  app.post('/api/video-playlists', express.json({ limit: '16kb' }), ah(async (req, res) => {
    const pl = ctx.playlists.createVideo(String((req.body as { name?: unknown })?.name || ''));
    ctx.store.touch('videoPlaylists');
    ctx.broadcastSnapshot();
    res.json({ ok: true, playlist: pl });
  }));

  app.put('/api/video-playlists/:id', express.json({ limit: '1mb' }), ah(async (req, res) => {
    const pl = ctx.playlists.updateVideo(req.params.id, req.body as { name?: string; videoIds?: string[] });
    if (!pl) return fail(res, 404, 'Плейлист не найден');
    ctx.store.touch('videoPlaylists');
    ctx.broadcastSnapshot();
    res.json({ ok: true, playlist: pl });
  }));

  app.delete('/api/video-playlists/:id', ah(async (req, res) => {
    const ok = ctx.playlists.deleteVideo(req.params.id);
    if (!ok) return fail(res, 404, 'Плейлист не найден');
    ctx.store.touch('videoPlaylists');
    ctx.broadcastSnapshot();
    res.json({ ok: true });
  }));

  // ─── Сценический вывод ───

  app.post('/api/stage/command', express.json({ limit: '64kb' }), ah(async (req, res) => {
    const { action, payload } = (req.body || {}) as { action?: string; payload?: Record<string, unknown> };
    if (!action) return fail(res, 400, 'Не указана команда сцены');
    const r = await ctx.stage.command(action, payload || {});
    if (r.ok) res.json({ ok: true });
    else if (r.needConfirm) res.status(409).json({ ok: false, needConfirm: true, error: r.error });
    else res.status(400).json({ ok: false, error: r.error });
    ctx.broadcastSnapshot();
  }));

  app.get('/api/displays', ah(async (_req, res) => {
    if (ctx.bridge) ctx.store.displays = ctx.bridge.getDisplays();
    res.json({ displays: ctx.store.displays });
  }));

  // ─── Soundboard ───

  app.get('/api/soundboard', ah(async (_req, res) => {
    res.json({ config: ctx.soundboard.config });
  }));

  app.put('/api/soundboard', express.json({ limit: '1mb' }), ah(async (req, res) => {
    const config = ctx.soundboard.replace(req.body as Record<string, unknown>);
    ctx.store.touch('soundboard');
    refreshHotkeys(ctx);
    ctx.broadcastSnapshot();
    res.json({ ok: true, config });
  }));

  app.post('/api/soundboard/import', express.json({ limit: '64kb' }), ah(async (req, res) => {
    const body = req.body as { sourcePath?: unknown; name?: unknown };
    if (typeof body.sourcePath !== 'string') return fail(res, 400, 'Не указан путь к звуку');
    try {
      const button = ctx.soundboard.importFromPath(body.sourcePath, typeof body.name === 'string' ? body.name : undefined);
      ctx.store.touch('soundboard');
      refreshHotkeys(ctx);
      ctx.broadcastSnapshot();
      res.json({ ok: true, button });
    } catch (err) {
      fail(res, 400, (err as Error).message || 'Не удалось импортировать звук');
    }
  }));

  app.post('/api/soundboard/upload', express.raw({ type: () => true, limit: '60mb' }), ah(async (req, res) => {
    const name = sanitizeFileName(String(req.query.name || 'Звук'));
    const ext = extOf(name) || '.wav';
    const buf = req.body as Buffer;
    if (!buf || buf.length < 64) return fail(res, 400, 'Пустой аудиофайл');
    const button = ctx.soundboard.importBinary(buf, ext, name.replace(ext, ''));
    ctx.store.touch('soundboard');
    refreshHotkeys(ctx);
    ctx.broadcastSnapshot();
    res.json({ ok: true, button });
  }));

  app.delete('/api/soundboard/button/:id', ah(async (req, res) => {
    const ok = ctx.soundboard.removeButton(req.params.id);
    if (!ok) return fail(res, 404, 'Кнопка не найдена');
    ctx.store.touch('soundboard');
    refreshHotkeys(ctx);
    ctx.broadcastSnapshot();
    res.json({ ok: true });
  }));

  app.post('/api/soundboard/trigger', express.json({ limit: '16kb' }), ah(async (req, res) => {
    const buttonId = String((req.body as { buttonId?: unknown })?.buttonId || '');
    if (!ctx.soundboard.config.buttons.some(b => b.id === buttonId)) {
      return fail(res, 404, 'Кнопка не найдена');
    }
    // Рассылаем всем: десктоп проигрывает звук, веб-клиенты — по своей настройке
    ctx.ws.broadcast({ type: 'command', target: 'all', domain: 'soundboard', action: 'trigger', payload: { buttonId } });
    res.json({ ok: true });
  }));

  app.post('/api/soundboard/stop-all', ah(async (_req, res) => {
    ctx.ws.broadcast({ type: 'command', target: 'all', domain: 'soundboard', action: 'stopAll' });
    res.json({ ok: true });
  }));

  // ─── Эквалайзер ───

  app.get('/api/equalizer', ah(async (_req, res) => {
    res.json({ eq: ctx.store.eq });
  }));

  app.put('/api/equalizer', express.json({ limit: '64kb' }), ah(async (req, res) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const eq = ctx.store.eq;
    if (typeof body.enabled === 'boolean') eq.enabled = body.enabled;
    if (typeof body.preset === 'string') eq.preset = body.preset;
    if (Array.isArray(body.gains) && body.gains.length === 10) {
      eq.gains = body.gains.map(g => clamp(Number(g) || 0, -12, 12));
      eq.preset = 'custom';
    }
    if (Array.isArray(body.customPresets)) {
      eq.customPresets = (body.customPresets as { name?: unknown; gains?: unknown }[])
        .filter(p => p && typeof p.name === 'string' && Array.isArray(p.gains) && p.gains.length === 10)
        .map(p => ({ name: String(p.name), gains: (p.gains as number[]).map(g => clamp(Number(g) || 0, -12, 12)) }));
    }
    ctx.store.touchEqSave(ctx.eqStore);
    // Реально применяем эквалайзер в desktop-плеере
    ctx.ws.sendToRoles(['ui'], { type: 'command', target: 'renderer', domain: 'eq', action: 'apply', payload: eq });
    ctx.broadcastSnapshot();
    res.json({ ok: true, eq });
  }));

  // ─── Настройки ───

  app.get('/api/settings', ah(async (_req, res) => {
    res.json({ settings: ctx.settings.data });
  }));

  app.put('/api/settings', express.json({ limit: '256kb' }), ah(async (req, res) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const s = ctx.settings.data;
    if (Array.isArray(body.musicFolders)) {
      s.musicFolders = (body.musicFolders as unknown[]).filter(x => typeof x === 'string').map(String);
    }
    if (Array.isArray(body.videoFolders)) {
      s.videoFolders = (body.videoFolders as unknown[]).filter(x => typeof x === 'string').map(String);
    }
    if (body.defaults && typeof body.defaults === 'object') {
      const d = body.defaults as Record<string, unknown>;
      if (typeof d.volume === 'number') s.defaults.volume = clamp(d.volume, 0, 1);
      if (typeof d.muted === 'boolean') s.defaults.muted = d.muted;
      if (typeof d.fadeIn === 'number') s.defaults.fadeIn = clampFade(d.fadeIn);
      if (typeof d.fadeOut === 'number') s.defaults.fadeOut = clampFade(d.fadeOut);
      if (typeof d.afterAction === 'string' && ['stop', 'black', 'next', 'loop'].includes(d.afterAction)) {
        s.defaults.afterAction = d.afterAction as VideoAfterAction;
      }
      if (typeof d.stopBehavior === 'string' && ['black', 'freeze'].includes(d.stopBehavior)) {
        s.defaults.stopBehavior = d.stopBehavior as 'black' | 'freeze';
      }
    }
    if (body.crossfade && typeof body.crossfade === 'object') {
      const c = body.crossfade as Record<string, unknown>;
      if (typeof c.enabled === 'boolean') s.crossfade.enabled = c.enabled;
      if (typeof c.duration === 'number') s.crossfade.duration = clamp(c.duration, 0.5, MAX_FADE_SECONDS);
    }
    if (body.splash && typeof body.splash === 'object') {
      const sp = body.splash as Record<string, unknown>;
      if (typeof sp.enabled === 'boolean') s.splash.enabled = sp.enabled;
      if (typeof sp.text === 'string') s.splash.text = sp.text.slice(0, 200);
      if (typeof sp.imagePath === 'string') s.splash.imagePath = sp.imagePath;
    }
    ctx.settings.scheduleSave();
    ctx.store.touch('settings');
    ctx.broadcastSnapshot();
    res.json({ ok: true, settings: s });
  }));

  // ─── Система ───

  app.post('/api/system/lan', express.json({ limit: '16kb' }), ah(async (req, res) => {
    const enabled = Boolean((req.body as { enabled?: unknown })?.enabled);
    ctx.settings.update(s => { s.lanEnabled = enabled; });
    ctx.log.info(`Доступ по локальной сети ${enabled ? 'включён' : 'выключен'}`);
    await restartListener(ctx);
    res.json({ ok: true, enabled, lanUrl: systemInfo(ctx).lanUrl });
  }));

  app.post('/api/system/pin/regenerate', ah(async (_req, res) => {
    const { randomPin, randomToken } = await import('./util');
    ctx.settings.update(s => { s.lanPin = randomPin(); s.lanToken = randomToken(); });
    ctx.broadcastSnapshot();
    res.json({ ok: true, pin: ctx.settings.data.lanPin });
  }));

  app.post('/api/system/port', express.json({ limit: '16kb' }), ah(async (req, res) => {
    const port = Number((req.body as { port?: unknown })?.port);
    if (!isFinite(port) || port < 1024 || port > 65535) {
      return fail(res, 400, 'Порт должен быть числом от 1024 до 65535');
    }
    ctx.settings.update(s => { s.port = port; });
    const ok = await restartListener(ctx);
    if (!ok) return fail(res, 500, `Не удалось занять порт ${port}. Возможно, он используется другой программой.`);
    res.json({ ok: true, port });
  }));

  app.get('/api/system/qr', ah(async (_req, res) => {
    const info = systemInfo(ctx);
    if (!info.lanUrl) return res.json({ qr: null, url: info.url });
    const QRCode = await import('qrcode');
    const qr = await QRCode.toDataURL(info.lanUrl, { width: 240, margin: 1 });
    res.json({ qr, url: info.lanUrl });
  }));

  app.get('/api/system/logs', ah(async (req, res) => {
    const lines = clamp(Number(req.query.lines) || 200, 10, 2000);
    res.json({ logs: ctx.log.tail(lines) });
  }));

  app.get('/api/system/backup', ah(async (_req, res) => {
    const backup = {
      kind: 'sonic-studio-backup',
      version: 1,
      exportedAt: new Date().toISOString(),
      settings: ctx.settings.data,
      playlists: ctx.playlists.listMusic(),
      videoPlaylists: ctx.playlists.listVideo(),
      soundboard: ctx.soundboard.config,
      eq: ctx.store.eq
    };
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="sonic-studio-backup-${Date.now()}.json"`);
    res.send(JSON.stringify(backup, null, 2));
  }));

  app.post('/api/system/restore', express.json({ limit: '10mb' }), ah(async (req, res) => {
    const body = req.body as Record<string, unknown>;
    if (body.kind !== 'sonic-studio-backup') return fail(res, 400, 'Это не файл резервной копии Sonic Studio');
    if (body.settings && typeof body.settings === 'object') {
      const s = ctx.settings.data;
      const src = body.settings as Record<string, unknown>;
      if (Array.isArray(src.musicFolders)) s.musicFolders = src.musicFolders.map(String);
      if (Array.isArray(src.videoFolders)) s.videoFolders = src.videoFolders.map(String);
      if (typeof src.stageDisplayId === 'number' || src.stageDisplayId === null) s.stageDisplayId = src.stageDisplayId as number | null;
      if (src.defaults && typeof src.defaults === 'object') Object.assign(s.defaults, src.defaults);
      if (src.crossfade && typeof src.crossfade === 'object') Object.assign(s.crossfade, src.crossfade);
      if (src.splash && typeof src.splash === 'object') Object.assign(s.splash, src.splash);
      ctx.settings.scheduleSave();
    }
    if (Array.isArray(body.playlists)) {
      for (const p of body.playlists as { id?: string; name?: string; trackIds?: string[] }[]) {
        if (p.id && ctx.playlists.musicById(p.id)) ctx.playlists.updateMusic(p.id, { name: p.name, trackIds: p.trackIds });
        else ctx.playlists.createMusic(String(p.name || 'Плейлист'));
      }
    }
    if (Array.isArray(body.videoPlaylists)) {
      for (const p of body.videoPlaylists as { id?: string; name?: string; videoIds?: string[] }[]) {
        if (p.id && ctx.playlists.videoById(p.id)) ctx.playlists.updateVideo(p.id, { name: p.name, videoIds: p.videoIds });
        else ctx.playlists.createVideo(String(p.name || 'Плейлист'));
      }
    }
    if (body.soundboard && typeof body.soundboard === 'object') ctx.soundboard.replace(body.soundboard as Record<string, unknown>);
    ctx.playlists.saveNow();
    ctx.soundboard.saveNow();
    ctx.store.touch('settings');
    ctx.store.touch('playlists');
    ctx.store.touch('videoPlaylists');
    ctx.store.touch('soundboard');
    refreshHotkeys(ctx);
    ctx.broadcastSnapshot();
    res.json({ ok: true });
  }));

  // ─── Аудиоредактор: экспорт ───

  /** Сохранение отрендеренного WAV (или любого аудио) с редактора. */
  app.post('/api/editor/save', express.raw({ type: () => true, limit: '500mb' }), ah(async (req, res) => {
    const buf = req.body as Buffer;
    if (!buf || buf.length < 44) return fail(res, 400, 'Пустой аудиофайл');
    const name = sanitizeFileName(String(req.query.name || 'export'));
    const overwrite = req.query.overwrite === '1';
    const beside = req.query.beside === '1';
    const sourcePath = String(req.query.source || '');

    let dir: string;
    if (beside && sourcePath) {
      const { safeResolve } = await import('./security');
      const src = safeResolve(ctx.allowedRoots(), sourcePath);
      if (!src) return fail(res, 403, 'Исходный файл недоступен для записи рядом с ним');
      dir = path.dirname(src);
    } else {
      dir = ctx.paths.exports;
    }
    const target = path.join(dir, `${name}.wav`);
    if (fs.existsSync(target) && !overwrite) {
      return res.status(409).json({ error: 'Файл с таким именем уже существует. Перезаписать?', code: 'EXISTS', path: target });
    }
    try {
      fs.writeFileSync(target, buf);
    } catch (err) {
      return fail(res, 500, `Не удалось экспортировать аудио: ${(err as Error).message}`);
    }
    ctx.log.info(`Аудиоредактор: экспорт ${target} (${buf.length} байт)`);
    res.json({ ok: true, path: target, size: buf.length });
  }));

  /** Экспорт в MP3 через FFmpeg (если доступен). */
  app.post('/api/editor/mp3', express.raw({ type: () => true, limit: '500mb' }), ah(async (req, res) => {
    const ff = ctx.ffmpegPath();
    if (!ff) {
      return fail(res, 501, 'FFmpeg недоступен. Экспорт в MP3 требует FFmpeg (см. README). Экспорт в WAV работает всегда.');
    }
    const buf = req.body as Buffer;
    if (!buf || buf.length < 44) return fail(res, 400, 'Пустой аудиофайл');
    const name = sanitizeFileName(String(req.query.name || 'export'));
    const { spawn } = await import('child_process');
    const tmpWav = path.join(ctx.paths.exports, `tmp-${Date.now()}.wav`);
    const target = path.join(ctx.paths.exports, `${name}.mp3`);
    if (fs.existsSync(target) && req.query.overwrite !== '1') {
      return res.status(409).json({ error: 'Файл с таким именем уже существует. Перезаписать?', code: 'EXISTS', path: target });
    }
    fs.writeFileSync(tmpWav, buf);
    try {
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(ff, ['-y', '-i', tmpWav, '-codec:a', 'libmp3lame', '-q:a', '2', target], { windowsHide: true });
        let stderr = '';
        proc.stderr.on('data', d => { stderr += String(d); });
        const timer = setTimeout(() => { proc.kill(); reject(new Error('FFmpeg не ответил за 120 секунд')); }, 120_000);
        proc.on('close', code => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error(`FFmpeg завершился с кодом ${code}. ${stderr.slice(-400)}`));
        });
        proc.on('error', err => { clearTimeout(timer); reject(err); });
      });
      res.json({ ok: true, path: target, size: fs.statSync(target).size });
    } catch (err) {
      ctx.log.error(`Экспорт MP3: ${(err as Error).message}`);
      fail(res, 500, 'Не удалось экспортировать MP3. Проверьте, что FFmpeg поддерживает libmp3lame.');
    } finally {
      try { fs.unlinkSync(tmpWav); } catch { /* ignore */ }
    }
  }));

  /** Добавить экспортированный файл в музыкальную библиотеку. */
  app.post('/api/editor/to-library', express.json({ limit: '16kb' }), ah(async (req, res) => {
    const p = String((req.body as { path?: unknown })?.path || '');
    if (!p) return fail(res, 400, 'Не указан путь');
    const r = await ctx.music.addFiles([p], ctx.paths.covers);
    ctx.store.touch('music');
    ctx.broadcastSnapshot();
    res.json({ ok: true, ...r });
  }));

  /** Добавить файл в Soundboard кнопкой. */
  app.post('/api/editor/to-soundboard', express.json({ limit: '16kb' }), ah(async (req, res) => {
    const p = String((req.body as { path?: unknown })?.path || '');
    const name = typeof (req.body as { name?: unknown })?.name === 'string' ? (req.body as { name: string }).name : undefined;
    if (!p) return fail(res, 400, 'Не указан путь');
    try {
      const button = ctx.soundboard.importFromPath(p, name);
      ctx.store.touch('soundboard');
      refreshHotkeys(ctx);
      ctx.broadcastSnapshot();
      res.json({ ok: true, button });
    } catch (err) {
      fail(res, 400, (err as Error).message || 'Не удалось добавить звук в Soundboard');
    }
  }));
}

// ─── Вспомогательные функции ───

function sanitizeVideoPatch(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof body.title === 'string') out.title = body.title.slice(0, 200);
  if (typeof body.volume === 'number') out.volume = clamp(body.volume, 0, 1);
  if (typeof body.muted === 'boolean') out.muted = body.muted;
  if (typeof body.startPosition === 'number') out.startPosition = clamp(body.startPosition, 0, 1e7);
  if (body.endPosition === null) out.endPosition = null;
  else if (typeof body.endPosition === 'number') out.endPosition = clamp(body.endPosition, 0, 1e7);
  if (typeof body.repeat === 'boolean') out.repeat = body.repeat;
  if (typeof body.fadeIn === 'number') out.fadeIn = clampFade(body.fadeIn);
  if (typeof body.fadeOut === 'number') out.fadeOut = clampFade(body.fadeOut);
  if (typeof body.afterAction === 'string' && ['stop', 'black', 'next', 'loop'].includes(body.afterAction)) {
    out.afterAction = body.afterAction as VideoAfterAction;
  }
  if (typeof body.stopBehavior === 'string' && ['black', 'freeze'].includes(body.stopBehavior)) {
    out.stopBehavior = body.stopBehavior;
  }
  if (body.nextVideoId === null) out.nextVideoId = null;
  else if (typeof body.nextVideoId === 'string') out.nextVideoId = body.nextVideoId;
  if (body.displayId === null) out.displayId = null;
  else if (typeof body.displayId === 'number') out.displayId = body.displayId;
  return out;
}

function startVideoScan(ctx: ServerContext, folders: string[]): void {
  const scan = ctx.store.scan;
  scan.active = true;
  scan.kind = 'video';
  scan.processed = 0;
  scan.total = 0;
  scan.current = '';
  scan.errors = [];
  ctx.broadcastSnapshot();
  setTimeout(() => {
    try {
      const r = ctx.videos.scan(folders, (processed, total, current) => {
        scan.processed = processed;
        scan.total = total;
        scan.current = current;
        ctx.broadcastSnapshot();
      });
      scan.active = false;
      scan.errors = r.errors.slice(0, 20);
      ctx.store.touch('videos');
      if (r.errors.length) ctx.toast('error', `Сканирование видео: ошибок ${r.errors.length}`);
      else ctx.toast('success', `Сканирование видео завершено: добавлено ${r.added}`);
      ctx.broadcastSnapshot();
    } catch (err) {
      scan.active = false;
      ctx.log.error(`Ошибка сканирования видео: ${(err as Error).message}`);
      ctx.toast('error', 'Не удалось выполнить сканирование видео');
      ctx.broadcastSnapshot();
    }
  }, 50);
}

/** Перерегистрация глобальных хоткеев soundboard при изменении конфигурации. */
export function refreshHotkeys(ctx: ServerContext): void {
  if (!ctx.bridge || !ctx.bridge.electronAvailable) return;
  const map: Record<string, string> = {};
  for (const b of ctx.soundboard.config.buttons) {
    if (b.hotkey) map[b.id] = b.hotkey;
  }
  const conflicts = ctx.bridge.registerHotkeys(map);
  if (conflicts.length > 0) {
    ctx.toast('error', `Некоторые горячие клавиши заняты другими программами: ${conflicts.join(', ')}`);
    ctx.log.warn(`Занятые хоткеи: ${conflicts.join(', ')}`);
  }
}

/**
 * Перезапуск HTTP-слушателя (смена порта или включение LAN).
 * Сервер и WS-хаб сохраняются, меняется только слушающий сокет.
 */
async function restartListener(ctx: ServerContext): Promise<boolean> {
  const s = ctx.settings.data;
  const host = s.lanEnabled ? '0.0.0.0' : '127.0.0.1';
  const target = s.port;
  try {
    await ctx.restartListener(host, target);
    ctx.log.info(`Сервер перезапущен: ${host}:${target}`);
    ctx.broadcastSnapshot();
    return true;
  } catch (err) {
    ctx.log.error(`Не удалось перезапустить слушатель: ${(err as Error).message}`);
    try {
      await ctx.restartListener('127.0.0.1', ctx.port);
    } catch {
      /* критическая ситуация — сервер недоступен */
    }
    return false;
  }
}

export { SoundMode };
