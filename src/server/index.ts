import * as http from 'http';
import express from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { WsHub } from './ws';
import { AppState } from './state';
import { JsonStore } from './store';
import { createSettingsStore } from './settings';
import { ensurePaths, AppPaths } from './paths';
import { Logger } from './logger';
import { MusicCatalog } from './library-music';
import { VideoCatalog } from './library-videos';
import { PlaylistManager } from './playlists';
import { SoundboardManager } from './soundboard';
import { StageController } from './stage';
import { QuickManager } from './quick';
import { ServerContext } from './context';
import { createAuthMiddleware, isLoopback } from './security';
import { resolveDataDir } from './paths';
import { registerCoreRoutes, systemInfo } from './routes-core';
import { registerExtraRoutes, refreshHotkeys } from './routes-extra';
import { isPortFree } from './net';
import { ElectronBridge, EqState, WsIn } from '../shared/types';

export interface StartOptions {
  dataDir?: string;
  port?: number;
  bridge?: ElectronBridge | null;
  electron?: boolean;
  appVersion?: string;
}

export interface RunningServer {
  port: number;
  url: string;
  ctx: ServerContext;
  close(): Promise<void>;
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self' ws: wss:",
  "font-src 'self' data:",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'"
].join('; ');

function detectFfmpeg(): { available: boolean; path: string | null } {
  const { spawnSync } = require('child_process') as typeof import('child_process');
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const candidates: string[] = [];
  // 1) Рядом с приложением (resources/ffmpeg) — для упакованной сборки
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'ffmpeg', exe));
  candidates.push(path.join(process.cwd(), 'ffmpeg-bin', exe));
  // 2) В PATH
  candidates.push(exe);
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ['-version'], { timeout: 5000, windowsHide: true });
      if (r.status === 0) return { available: true, path: c };
    } catch {
      /* пробуем следующий вариант */
    }
  }
  return { available: false, path: null };
}

export async function startSonicServer(opts: StartOptions = {}): Promise<RunningServer> {
  const paths: AppPaths = ensurePaths(resolveDataDir(opts.dataDir));
  const log = new Logger(paths.logs);
  const electron = Boolean(opts.electron && opts.bridge);
  const bridge = opts.bridge ?? null;

  log.info(`=== Sonic Studio запускается (dataDir: ${paths.root}, electron: ${electron}) ===`);

  const settings = createSettingsStore(paths);
  const eqStore = new JsonStore<EqState>(path.join(paths.settings, 'eq.json'), {
    enabled: false, preset: 'Flat', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], customPresets: []
  }, 400);
  const store = new AppState(eqStore);

  const music = new MusicCatalog(paths, log);
  const videos = new VideoCatalog(paths, log);
  const playlists = new PlaylistManager(paths);
  const soundboard = new SoundboardManager(paths);
  const quick = new QuickManager(paths);

  // Определяем порт: из настроек или указанный
  let port = opts.port ?? settings.data.port;
  const host = () => (settings.data.lanEnabled ? '0.0.0.0' : '127.0.0.1');

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);

  // CSP и базовые заголовки
  app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  // CORS: для API и медиа (авторизация всё равно обязательна вне loopback)
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-auth-token');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  // Авторизация: loopback — свободно, LAN — по токену
  app.use('/api', createAuthMiddleware(() => ({
    lanEnabled: settings.data.lanEnabled,
    token: settings.data.lanToken,
    pin: settings.data.lanPin
  })));

  // Статика собранного renderer'а
  const rendererDir = path.resolve(__dirname, '..', 'renderer');
  if (fs.existsSync(rendererDir)) {
    app.use(express.static(rendererDir, { index: 'index.html', maxAge: '1h' }));
  }

  const ctx: ServerContext = {
    electron,
    paths,
    log,
    settings,
    store,
    eqStore,
    ws: null as unknown as WsHub, // заполняется ниже
    music,
    videos,
    playlists,
    soundboard,
    quick,
    stage: null as unknown as StageController,
    bridge,
    ffmpeg: detectFfmpeg(),
    appVersion: opts.appVersion || '1.0.0',
    startedAt: Date.now(),
    port,
    setPort(p: number) { port = p; ctx.port = p; },
    async restartListener(targetHost: string, targetPort: number): Promise<void> {
      return new Promise((resolve, reject) => {
        httpServer.close((err) => {
          const listen = () => {
            httpServer.listen(targetPort, targetHost, () => {
              ctx.setPort(targetPort);
              log.info(`Слушатель: http://${targetHost}:${targetPort}`);
              resolve();
            });
          };
          if (err) {
            // Сервер мог быть не запущен — просто слушаем заново
            listen();
          } else {
            listen();
          }
        });
      });
    },
    allowedRoots(): string[] {
      const s = settings.data;
      return [
        ...s.musicFolders,
        ...s.videoFolders,
        paths.soundFiles,
        paths.exports,
        paths.covers,
        paths.thumbs
      ];
    },
    broadcastSnapshot(): void {
      if (!ctx.ws) return;
      ctx.ws.broadcast({ type: 'snapshot', snapshot: store.snapshot(systemInfo(ctx)) });
    },
    toast(level, message): void {
      log.info(`Уведомление [${level}]: ${message}`);
      ctx.ws?.broadcast({ type: 'toast', level, message });
    },
    ffmpegPath(): string | null {
      return ctx.ffmpeg.path;
    }
  };
  ctx.stage = new StageController(ctx);

  registerCoreRoutes(app, ctx);
  registerExtraRoutes(app, ctx);

  // Обработка ошибок маршрутов — понятный JSON без трассировок
  app.use('/api', (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    log.error(`API: ${err.message}`);
    res.status(500).json({ error: 'Внутренняя ошибка сервера. Подробности в журнале.' });
  });

  // SPA fallback: всё, что не /api, отдаёт index.html
  app.get('*', (req, res) => {
    const indexFile = path.join(rendererDir, 'index.html');
    if (fs.existsSync(indexFile)) {
      res.sendFile(indexFile);
    } else {
      res.status(200).send('<!doctype html><html lang="ru"><meta charset="utf-8"><title>Sonic Studio</title>' +
        '<body style="background:#0e1014;color:#e8eaf0;font-family:sans-serif;display:grid;place-items:center;height:100vh">' +
        '<div>Интерфейс не собран. Выполните <code>npm run build:renderer</code>.</div></body>');
    }
  });

  // Поиск свободного порта (0 = эфемерный, ОС выберет сама)
  const requestedPort = port;
  let actualPort = 0;
  if (requestedPort !== 0) {
    for (let attempt = 0; attempt <= 20; attempt++) {
      const candidate = requestedPort + attempt;
      if (await isPortFree(host(), candidate)) {
        actualPort = candidate;
        break;
      }
      log.warn(`Порт ${candidate} занят, пробуем следующий`);
    }
    if (actualPort === 0) {
      log.error('Не удалось найти свободный порт в диапазоне ' + requestedPort + '-' + (requestedPort + 20));
      throw new Error(`Не удалось запустить сервер: порты ${requestedPort}–${requestedPort + 20} заняты`);
    }
  }

  const httpServer = http.createServer(app);
  const ws = new WsHub(httpServer, (req) => {
    if (isLoopbackHttp(req)) return true;
    if (!settings.data.lanEnabled) return false;
    const url = new URL(req.url || '/', 'http://localhost');
    return url.searchParams.get('token') === settings.data.lanToken;
  });
  ctx.ws = ws;

  ws.onMessage((msg: WsIn, client) => {
    if (msg.type !== 'report') return;
    if (msg.domain === 'stage') {
      ctx.stage.report(msg.data);
    } else if (msg.domain === 'player' && client.loopback) {
      // Отчёты о музыке принимает только с локальной машины (desktop-плеер)
      handlePlayerReport(ctx, msg.data);
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', (err) => reject(err));
    httpServer.listen(actualPort, host(), () => resolve());
  });
  // Для эфемерного порта (0) берём фактический из адреса
  const addr = httpServer.address();
  if (addr && typeof addr === 'object') actualPort = addr.port;
  ctx.setPort(actualPort);
  if (actualPort !== settings.data.port && !opts.port) {
    settings.update(s => { s.port = actualPort; });
  }

  log.info(`Сервер запущен: http://127.0.0.1:${actualPort} (LAN: ${settings.data.lanEnabled ? 'включён' : 'выключен'}, FFmpeg: ${ctx.ffmpeg.available ? ctx.ffmpeg.path : 'нет'})`);

  // Регистрируем глобальные хоткеи soundboard
  refreshHotkeys(ctx);
  // Первичный список дисплеев
  if (bridge && bridge.electronAvailable) {
    store.displays = bridge.getDisplays();
  }

  store.stage.displayId = settings.data.stageDisplayId ?? null;
  store.player.volume = settings.data.player.volume;
  store.player.muted = settings.data.player.muted;
  store.player.shuffle = settings.data.player.shuffle;
  store.player.repeat = settings.data.player.repeat;

  return {
    port: actualPort,
    url: `http://127.0.0.1:${actualPort}`,
    ctx,
    async close(): Promise<void> {
      log.info('Остановка сервера...');
      try { music.saveNow(); videos.saveNow(); playlists.saveNow(); soundboard.saveNow(); quick.saveNow(); } catch { /* ignore */ }
      try { await ws.close(); } catch { /* ignore */ }
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
        setTimeout(resolve, 1500).unref?.();
      });
      log.info('Сервер остановлен');
    }
  };
}

function isLoopbackHttp(req: { socket: { remoteAddress?: string } }): boolean {
  const addr = req.socket.remoteAddress || '';
  return addr === '127.0.0.1' || addr === '::1' || addr.startsWith('::ffff:127.');
}

function handlePlayerReport(ctx: ServerContext, data: Record<string, unknown>): void {
  const p = ctx.store.player;
  if (typeof data.trackId === 'string' && data.trackId !== p.trackId) {
    const t = ctx.music.byId(data.trackId);
    if (t) {
      ctx.music.addHistory(t);
      ctx.store.touch('history');
      p.title = t.title;
      p.artist = t.artist;
    }
  }
  if (typeof data.trackId === 'string') p.trackId = data.trackId;
  if (typeof data.status === 'string') p.status = data.status as typeof p.status;
  if (typeof data.position === 'number') p.position = data.position;
  if (typeof data.duration === 'number') p.duration = data.duration;
  if (typeof data.volume === 'number') {
    p.volume = Math.min(1, Math.max(0, data.volume));
    ctx.settings.update(s => { s.player.volume = p.volume; });
  }
  if (typeof data.muted === 'boolean') {
    p.muted = data.muted;
    ctx.settings.update(s => { s.player.muted = p.muted; });
  }
  if (typeof data.shuffle === 'boolean') {
    p.shuffle = data.shuffle;
    ctx.settings.update(s => { s.player.shuffle = p.shuffle; });
  }
  if (typeof data.repeat === 'string') {
    p.repeat = data.repeat as typeof p.repeat;
    ctx.settings.update(s => { s.player.repeat = p.repeat; });
  }
  if (Array.isArray(data.queue)) p.queue = (data.queue as unknown[]).map(String);
  if (typeof data.queueIndex === 'number') p.queueIndex = data.queueIndex;
  p.updatedAt = Date.now();
  ctx.broadcastSnapshot();
}


