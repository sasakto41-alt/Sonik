import { AppPaths } from './paths';
import { Logger } from './logger';
import { JsonStore } from './store';
import { Settings, EqState, ElectronBridge } from '../shared/types';
import { AppState } from './state';
import { WsHub } from './ws';
import { MusicCatalog } from './library-music';
import { VideoCatalog } from './library-videos';
import { ImageLibrary } from './library-images';
import { PlaylistManager } from './playlists';
import { SoundboardManager } from './soundboard';
import { StageController } from './stage';

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
  images: ImageLibrary;
  playlists: PlaylistManager;
  soundboard: SoundboardManager;
  stage: StageController;
  bridge: ElectronBridge | null;
  ffmpeg: { available: boolean; path: string | null };
  appVersion: string;
  startedAt: number;
  port: number;
  /** Текущий фактический порт слушателя. */
  setPort(p: number): void;
  allowedRoots(): string[];
  broadcastSnapshot(): void;
  toast(level: 'info' | 'success' | 'error', message: string): void;
  ffmpegPath(): string | null;
}
