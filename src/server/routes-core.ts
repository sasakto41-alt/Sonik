import express from 'express';
import * as path from 'path';
import { ServerContext } from './context';
import { ah, fail, uuid } from './util';
import { LoginGuard } from './security';
import { streamFile, streamChecked } from './media';
import { clamp, PlayerState, RepeatMode } from '../shared/types';

/**
 * Маршруты: health, auth, состояние, музыкальный плеер, музыка, плейлисты, медиа-стриминг.
 */
export function registerCoreRoutes(app: express.Express, ctx: ServerContext): void {
  const loginGuard = new LoginGuard();

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, app: 'Sonic Studio', version: ctx.appVersion });
  });

  // ─── Авторизация для LAN-устройств ───

  app.post('/api/auth/login', express.json({ limit: '16kb' }), (req, res) => {
    const ip = req.socket.remoteAddress || 'unknown';
    const gate = loginGuard.canAttempt(ip);
    if (!gate.ok) {
      return fail(res, 429, `Слишком много попыток. Повторите через ${gate.retryAfterSec} с.`);
    }
    const pin = String((req.body as { pin?: unknown })?.pin || '');
    if (pin && pin === ctx.settings.data.lanPin) {
      loginGuard.reset(ip);
      return res.json({ ok: true, token: ctx.settings.data.lanToken });
    }
    loginGuard.fail(ip);
    ctx.log.warn(`Неудачная попытка входа с ${ip}`);
    return fail(res, 401, 'Неверный PIN-код. PIN отображается в настройках Sonic Studio на компьютере.');
  });

  // ─── Состояние ───

  app.get('/api/state', ah(async (_req, res) => {
    res.json(ctx.store.snapshot(systemInfo(ctx)));
  }));

  // ─── Музыкальный плеер ───

  app.post('/api/player/command', express.json({ limit: '256kb' }), ah(async (req, res) => {
    const { action, payload } = (req.body || {}) as { action?: string; payload?: Record<string, unknown> };
    if (!action) return fail(res, 400, 'Не указано действие плеера');
    const r = playerCommand(ctx, action, payload || {});
    ctx.broadcastSnapshot();
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
  }));

  /** Отчёт от desktop-плеера (он — источник истины по воспроизведению музыки). */
  app.post('/api/player/report', express.json({ limit: '64kb' }), ah(async (req, res) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const p = ctx.store.player;
    if (typeof body.trackId === 'string') {
      if (body.trackId !== p.trackId) {
        const t = ctx.music.byId(body.trackId);
        if (t) {
          ctx.music.addHistory(t);
          ctx.store.touch('history');
          p.title = t.title;
          p.artist = t.artist;
        }
      }
      p.trackId = body.trackId;
    }
    if (typeof body.status === 'string') p.status = body.status as PlayerState['status'];
    if (typeof body.position === 'number') p.position = body.position;
    if (typeof body.duration === 'number') p.duration = body.duration;
    if (typeof body.volume === 'number') {
      p.volume = clamp(body.volume, 0, 1);
      ctx.settings.update(s => { s.player.volume = p.volume; });
    }
    if (typeof body.muted === 'boolean') {
      p.muted = body.muted;
      ctx.settings.update(s => { s.player.muted = p.muted; });
    }
    if (typeof body.shuffle === 'boolean') {
      p.shuffle = body.shuffle;
      ctx.settings.update(s => { s.player.shuffle = p.shuffle; });
    }
    if (typeof body.repeat === 'string') {
      p.repeat = body.repeat as RepeatMode;
      ctx.settings.update(s => { s.player.repeat = p.repeat; });
    }
    if (Array.isArray(body.queue)) p.queue = body.queue.map(String);
    if (typeof body.queueIndex === 'number') p.queueIndex = body.queueIndex;
    p.updatedAt = Date.now();
    res.json({ ok: true });
    ctx.broadcastSnapshot();
  }));

  // ─── Музыка ───

  app.get('/api/music/tracks', ah(async (req, res) => {
    const tracks = ctx.music.list({
      search: str(req.query.search),
      sort: str(req.query.sort),
      order: str(req.query.order),
      favorite: req.query.favorite === '1' || req.query.favorite === 'true'
    });
    res.json({ tracks, total: tracks.length });
  }));

  app.post('/api/music/files', express.json({ limit: '1mb' }), ah(async (req, res) => {
    const pathsList = (req.body as { paths?: unknown })?.paths;
    if (!Array.isArray(pathsList)) return fail(res, 400, 'Не передан список файлов');
    const r = await ctx.music.addFiles(pathsList.map(String), ctx.paths.covers);
    ctx.store.touch('music');
    ctx.broadcastSnapshot();
    res.json({ ok: true, ...r });
  }));

  app.post('/api/music/scan', express.json({ limit: '64kb' }), ah(async (req, res) => {
    const folders = Array.isArray((req.body as { folders?: unknown })?.folders)
      ? (req.body as { folders: string[] }).folders.map(String)
      : ctx.settings.data.musicFolders;
    if (ctx.store.scan.active) return fail(res, 409, 'Сканирование уже выполняется, подождите');
    startMusicScan(ctx, folders);
    res.json({ ok: true });
  }));

  app.post('/api/music/favorite', express.json({ limit: '16kb' }), ah(async (req, res) => {
    const { id, favorite } = req.body as { id?: string; favorite?: boolean };
    if (!id) return fail(res, 400, 'Не указан трек');
    const ok = ctx.music.setFavorite(id, Boolean(favorite));
    if (!ok) return fail(res, 404, 'Трек не найден');
    res.json({ ok: true });
  }));

  app.post('/api/music/missing', express.json({ limit: '16kb' }), ah(async (req, res) => {
    const { id, missing } = req.body as { id?: string; missing?: boolean };
    const t = id ? ctx.music.byId(id) : undefined;
    if (!t) return fail(res, 404, 'Трек не найден');
    t.missing = Boolean(missing);
    ctx.broadcastSnapshot();
    res.json({ ok: true });
  }));

  app.delete('/api/music/tracks/:id', ah(async (req, res) => {
    const ok = ctx.music.remove(req.params.id);
    if (!ok) return fail(res, 404, 'Трек не найден');
    ctx.store.touch('music');
    ctx.broadcastSnapshot();
    res.json({ ok: true });
  }));

  app.get('/api/music/cover/:id', ah(async (req, res) => {
    const t = ctx.music.byId(req.params.id);
    if (!t || !t.coverFile) return res.status(404).json({ error: 'Обложка отсутствует' });
    streamChecked(req, res, [ctx.paths.covers], path.join(ctx.paths.covers, path.basename(t.coverFile)));
  }));

  app.get('/api/music/history', ah(async (_req, res) => {
    res.json({ items: ctx.music.getHistory() });
  }));

  // ─── Плейлисты (музыка) ───

  app.get('/api/playlists', ah(async (_req, res) => {
    res.json({ playlists: ctx.playlists.listMusic() });
  }));

  app.post('/api/playlists', express.json({ limit: '16kb' }), ah(async (req, res) => {
    const name = String((req.body as { name?: unknown })?.name || '');
    const pl = ctx.playlists.createMusic(name);
    ctx.store.touch('playlists');
    ctx.broadcastSnapshot();
    res.json({ ok: true, playlist: pl });
  }));

  app.put('/api/playlists/:id', express.json({ limit: '1mb' }), ah(async (req, res) => {
    const pl = ctx.playlists.updateMusic(req.params.id, req.body as { name?: string; trackIds?: string[] });
    if (!pl) return fail(res, 404, 'Плейлист не найден');
    ctx.store.touch('playlists');
    ctx.broadcastSnapshot();
    res.json({ ok: true, playlist: pl });
  }));

  app.delete('/api/playlists/:id', ah(async (req, res) => {
    const ok = ctx.playlists.deleteMusic(req.params.id);
    if (!ok) return fail(res, 404, 'Плейлист не найден');
    ctx.store.touch('playlists');
    ctx.broadcastSnapshot();
    res.json({ ok: true });
  }));

  app.post('/api/playlists/:id/tracks', express.json({ limit: '1mb' }), ah(async (req, res) => {
    const pl = ctx.playlists.musicById(req.params.id);
    if (!pl) return fail(res, 404, 'Плейлист не найден');
    const body = req.body as { trackIds?: unknown; mode?: unknown };
    const ids = Array.isArray(body.trackIds) ? body.trackIds.map(String) : [];
    const mode = body.mode === 'set' ? 'set' : 'append';
    const filtered = ids.filter(id => ctx.music.byId(id));
    pl.trackIds = mode === 'set' ? filtered : [...pl.trackIds, ...filtered];
    pl.updatedAt = Date.now();
    ctx.store.touch('playlists');
    ctx.broadcastSnapshot();
    res.json({ ok: true, playlist: pl });
  }));

  // ─── Медиа-стриминг ───

  app.get('/api/media/audio/:id', ah(async (req, res) => {
    const t = ctx.music.byId(req.params.id);
    if (!t) return fail(res, 404, 'Трек не найден в библиотеке');
    streamChecked(req, res, ctx.allowedRoots(), t.path);
  }));

  app.get('/api/media/video/:id', ah(async (req, res) => {
    const v = ctx.videos.byId(req.params.id);
    if (!v) return fail(res, 404, 'Видео не найдено в библиотеке');
    streamChecked(req, res, ctx.allowedRoots(), v.path);
  }));

  app.get('/api/media/sound/:buttonId', ah(async (req, res) => {
    const p = ctx.soundboard.fileOf(req.params.buttonId);
    if (!p) return fail(res, 404, 'Звук не найден. Возможно, файл был удалён.');
    streamFile(req, res, p);
  }));

  /** Файл по явному пути — только из разрешённых каталогов (для аудиоредактора и т.п.). */
  app.get('/api/media/file', ah(async (req, res) => {
    const p = String(req.query.path || '');
    if (!p) return fail(res, 400, 'Не указан путь');
    streamChecked(req, res, ctx.allowedRoots(), p);
  }));
}

// ─── Вспомогательные функции ───

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

export function systemInfo(ctx: ServerContext) {
  const { networkAddress } = require('./net') as { networkAddress(): string };
  const ip = networkAddress();
  const port = ctx.port;
  return {
    appVersion: ctx.appVersion,
    platform: process.platform,
    electron: ctx.electron,
    ip,
    port,
    url: `http://127.0.0.1:${port}`,
    lanUrl: ctx.settings.data.lanEnabled && ip ? `http://${ip}:${port}` : null,
    lanEnabled: ctx.settings.data.lanEnabled,
    pin: ctx.settings.data.lanPin,
    ffmpeg: ctx.ffmpeg.available,
    startedAt: ctx.startedAt
  };
}

/** Команды плеера: оптимистично меняем состояние и пересылаем desktop-плееру. */
export function playerCommand(ctx: ServerContext, action: string, payload: Record<string, unknown>): { ok: boolean; error?: string } {
  const p = ctx.store.player;
  const fwd = () => ctx.ws.sendToRoles(['ui'], { type: 'command', target: 'renderer', domain: 'player', action, payload });
  switch (action) {
    case 'play': case 'pause': case 'toggle': case 'next': case 'prev':
      fwd(); return { ok: true };
    case 'stop':
      fwd(); p.status = 'stopped'; p.position = 0; return { ok: true };
    case 'seek': {
      const t = Number(payload.time);
      if (!isFinite(t)) return { ok: false, error: 'Некорректное время' };
      p.position = t; fwd(); return { ok: true };
    }
    case 'setVolume': {
      const v = clamp(Number(payload.volume), 0, 1);
      if (!isFinite(v)) return { ok: false, error: 'Некорректная громкость' };
      p.volume = v; p.muted = false; fwd();
      ctx.settings.update(s => { s.player.volume = v; s.player.muted = false; });
      return { ok: true };
    }
    case 'setMuted': {
      p.muted = Boolean(payload.muted); fwd();
      ctx.settings.update(s => { s.player.muted = p.muted; });
      return { ok: true };
    }
    case 'toggleShuffle':
      p.shuffle = !p.shuffle; fwd();
      ctx.settings.update(s => { s.player.shuffle = p.shuffle; });
      return { ok: true };
    case 'cycleRepeat': {
      const order: RepeatMode[] = ['off', 'all', 'one'];
      p.repeat = order[(order.indexOf(p.repeat) + 1) % 3];
      fwd();
      ctx.settings.update(s => { s.player.repeat = p.repeat; });
      return { ok: true };
    }
    case 'playTrack': {
      const id = String(payload.trackId || '');
      if (!ctx.music.byId(id)) return { ok: false, error: 'Трек не найден в библиотеке' };
      p.trackId = id;
      p.status = 'playing';
      const q = Array.isArray(payload.queue) ? payload.queue.map(String) : [id];
      p.queue = q.filter(x => ctx.music.byId(x));
      p.queueIndex = Math.max(0, p.queue.indexOf(id));
      fwd();
      return { ok: true };
    }
    case 'addToQueue': {
      const id = String(payload.trackId || '');
      if (!ctx.music.byId(id)) return { ok: false, error: 'Трек не найден' };
      if (payload.next) p.queue.splice(p.queueIndex + 1, 0, id);
      else p.queue.push(id);
      fwd(); return { ok: true };
    }
    case 'removeQueueItem': {
      const i = Number(payload.index);
      if (!isFinite(i) || i < 0 || i >= p.queue.length) return { ok: false, error: 'Некорректный элемент очереди' };
      p.queue.splice(i, 1);
      if (i < p.queueIndex) p.queueIndex--;
      fwd(); return { ok: true };
    }
    case 'clearQueue':
      p.queue = p.trackId ? [p.trackId] : [];
      p.queueIndex = p.trackId ? 0 : -1;
      fwd(); return { ok: true };
    case 'setQueueIndex': {
      const i = Number(payload.index);
      if (!isFinite(i) || i < 0 || i >= p.queue.length) return { ok: false, error: 'Некорректный элемент очереди' };
      p.queueIndex = i;
      p.trackId = p.queue[i];
      p.status = 'playing';
      fwd(); return { ok: true };
    }
    default:
      return { ok: false, error: `Неизвестная команда плеера: ${action}` };
  }
}

/** Фоновое сканирование музыкальных каталогов. */
export function startMusicScan(ctx: ServerContext, folders: string[]): void {
  const scan = ctx.store.scan;
  scan.active = true;
  scan.kind = 'music';
  scan.processed = 0;
  scan.total = 0;
  scan.current = '';
  scan.errors = [];
  ctx.broadcastSnapshot();
  ctx.music.scan(folders, ctx.paths.covers, (processed, total, current) => {
    scan.processed = processed;
    scan.total = total;
    scan.current = current;
    ctx.broadcastSnapshot();
  }).then(r => {
    scan.active = false;
    scan.errors = r.errors.slice(0, 20);
    ctx.store.touch('music');
    if (r.errors.length) ctx.toast('error', `Сканирование: ошибок ${r.errors.length} (подробно в журнале)`);
    else ctx.toast('success', `Сканирование завершено: добавлено ${r.added}, обновлено ${r.updated}`);
    r.errors.forEach(e => ctx.log.warn(`Скан музыки: ${e}`));
    ctx.broadcastSnapshot();
  }).catch(err => {
    scan.active = false;
    ctx.log.error(`Ошибка сканирования музыки: ${(err as Error).message}`);
    ctx.toast('error', 'Не удалось выполнить сканирование музыки');
    ctx.broadcastSnapshot();
  });
}

export { uuid };
