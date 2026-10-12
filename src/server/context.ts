import { AppPaths } from './paths';
import { Logger } from './logger';
import { JsonStore } from './store';
import { Settings, Snapshot, EqState, ElectronBridge } from '../shared/types';
import { AppState } from './state';
import { WsHub } from './ws';
import { MusicCatalog } from './library-music';
import { VideoCatalog } from './library-videos';
import { PlaylistManager } from './playlists';
import { SoundboardManager } from './soundboard';
import { StageController } from './stage';
import { QuickManager } from './quick';

/**
 * Общий контекст сервера — передаётся во все модули и маршруты.
 */
export interface ServerContext {
  electron: boolean;
  paths: AppPaths;
  log: Logger;
  settings: JsonStore<Settings>;
  store: AppState;
  eqStore: JsonStore<EqState>;
  ws: WsHub;
  music: MusicCatalog;
  videos: VideoCatalog;
  playlists: PlaylistManager;
  soundboard: SoundboardManager;
  quick: QuickManager;
  stage: StageController;
  bridge: ElectronBridge | null;
  ffmpeg: { available: boolean; path: string | null };
  appVersion: string;
  startedAt: number;
  port: number;
  /** Текущий фактический порт слушателя. */
  setPort(p: number): void;
  /** Перезапуск HTTP-слушателя на новом хосте/порту (WS-хаб сохраняется). */
  restartListener(host: string, port: number): Promise<void>;
  allowedRoots(): string[];
  broadcastSnapshot(): void;
  toast(level: 'info' | 'success' | 'error', message: string): void;
  ffmpegPath(): string | null;
}
