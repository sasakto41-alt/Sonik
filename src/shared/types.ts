/**
 * Общие типы Sonic Studio — используются main-процессом, сервером и renderer'ом.
 */

// ─── Константы ───────────────────────────────────────────────────────────────

export const EQ_BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

export const AUDIO_EXTS = ['.mp3', '.wav', '.flac', '.ogg', '.oga', '.m4a', '.aac', '.opus'];
export const VIDEO_EXTS = ['.mp4', '.webm', '.m4v', '.mov', '.mkv', '.avi'];
/** Форматы картинок для сценического вывода (то, что умеет рендерить Chromium). */
export const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
/** Форматы, которые браузерный декодер воспроизводит не гарантированно. */
export const RISKY_VIDEO_EXTS = ['.mkv', '.avi', '.mov'];

export const MAX_FADE_SECONDS = 10;

export const EQ_PRESETS: Record<string, number[]> = {
  'Flat': [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  'Bass Boost': [7, 6, 5, 3, 1, 0, 0, 0, 0, 0],
  'Treble Boost': [0, 0, 0, 0, 0, 1, 3, 5, 6, 7],
  'Rock': [5, 4, 3, 1, -1, -1, 1, 3, 4, 5],
  'Pop': [-1, 1, 3, 4, 3, 1, 0, -1, -1, -2],
  'Classical': [4, 3, 2, 1, -1, -1, 0, 2, 3, 4]
};

// ─── Медиатека ───────────────────────────────────────────────────────────────

export interface Track {
  id: string;
  path: string;
  title: string;
  artist: string;
  album: string;
  duration: number;      // секунды, 0 — неизвестно
  format: string;        // 'mp3' и т.п.
  size: number;
  mtime: number;
  favorite: boolean;
  missing: boolean;
  coverFile?: string;    // имя файла в cache/covers
  addedAt: number;
  playCount: number;
  lastPlayedAt?: number;
}

export interface VideoItem {
  id: string;
  path: string;
  title: string;
  duration: number;
  format: string;
  size: number;
  mtime: number;
  missing: boolean;
  thumbFile?: string;    // имя файла в cache/thumbs
  /** Настройки воспроизведения конкретного ролика */
  volume: number;        // 0..1
  muted: boolean;
  startPosition: number; // секунды
  endPosition?: number;  // ограничение длительности
  repeat: boolean;
  fadeIn: number;        // сек, 0..10
  fadeOut: number;       // сек, 0..10
  afterAction: VideoAfterAction;
  stopBehavior: 'black' | 'freeze';
  nextVideoId?: string;
  displayId?: number;    // предпочитаемый экран
  addedAt: number;
  lastPosition?: number; // запомненная позиция
  lastPlayedAt?: number;
}

export type VideoAfterAction = 'stop' | 'black' | 'next' | 'loop';

/** Картинка для показа на сценическом выводе (файл остаётся в своей папке). */
export interface ImageAsset {
  id: string;
  path: string;
  title: string;
  format: string;        // 'jpg' и т.п.
  size: number;
  mtime: number;
  missing: boolean;
  addedAt: number;
}

export interface Playlist {
  id: string;
  name: string;
  trackIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface VideoPlaylist {
  id: string;
  name: string;
  videoIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface HistoryEntry {
  id: string;
  title: string;
  subtitle: string;
  at: number;
}

// ─── Soundboard ──────────────────────────────────────────────────────────────

export type SoundMode = 'once' | 'loop' | 'toggle';

export interface SoundButton {
  id: string;
  name: string;
  file: string;          // имя файла внутри soundboard/files
  color: string;
  icon: string;
  volume: number;        // 0..1
  hotkey?: string;       // Electron-акселератор, напр. 'CommandOrControl+Shift+1'
  mode: SoundMode;
  overlap: boolean;      // разрешить наложение
  setId: string;
}

export interface SoundSet {
  id: string;
  name: string;
}

export interface SoundboardConfig {
  sets: SoundSet[];
  buttons: SoundButton[];
}

// ─── Состояние плеера и сцены ────────────────────────────────────────────────

export type RepeatMode = 'off' | 'one' | 'all';
export type PlayerStatus = 'stopped' | 'playing' | 'paused';
export type StageStatus = 'idle' | 'playing' | 'paused' | 'stopped';

export interface PlayerState {
  trackId: string | null;
  title: string;
  artist: string;
  status: PlayerStatus;
  position: number;
  duration: number;
  volume: number;
  muted: boolean;
  shuffle: boolean;
  repeat: RepeatMode;
  queue: string[];
  queueIndex: number;
  updatedAt: number;
}

export interface StageState {
  status: StageStatus;
  videoId: string | null;
  videoTitle: string;
  /** Картинка, показанная на экране сцены (если есть). */
  imageId: string | null;
  imageTitle: string;
  position: number;
  duration: number;
  volume: number;
  muted: boolean;
  repeat: boolean;
  playlist: string[];
  playlistIndex: number;
  displayId: number | null;
  pendingDisplayId: number | null;   // дисплей, выбранный пользователем, но недоступный
  fullscreen: boolean;
  blacked: boolean;
  splash: boolean;
  activeFade: 'in' | 'out' | null;
  fadeIn: number;
  fadeOut: number;
  windowOpen: boolean;
  nextVideoTitle: string;
  error: string | null;
  updatedAt: number;
}

export interface EqState {
  enabled: boolean;
  preset: string;         // имя пресета или 'custom'
  gains: number[];        // дБ, длина 10
  customPresets: { name: string; gains: number[] }[];
}

export interface DisplayInfo {
  id: number;
  label: string;
  bounds: { x: number; y: number; width: number; height: number };
  workArea: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
  primary: boolean;
  isStage: boolean;
  available: boolean;
}

export interface ScanStatus {
  active: boolean;
  kind: 'music' | 'video' | null;
  processed: number;
  total: number;
  current: string;
  errors: string[];
}

export interface SystemInfo {
  appVersion: string;
  platform: string;
  electron: boolean;
  ip: string;
  port: number;
  url: string;
  ffmpeg: boolean;
  startedAt: number;
}

export interface LibraryRevisions {
  music: number;
  videos: number;
  playlists: number;
  videoPlaylists: number;
  soundboard: number;
  settings: number;
  history: number;
}

export interface Snapshot {
  version: number;
  player: PlayerState;
  stage: StageState;
  eq: EqState;
  displays: DisplayInfo[];
  scan: ScanStatus;
  system: SystemInfo;
  revisions: LibraryRevisions;
}

// ─── Настройки ───────────────────────────────────────────────────────────────

export interface Settings {
  port: number;
  musicFolders: string[];
  videoFolders: string[];
  imageFolders: string[];
  stageDisplayId: number | null;
  defaults: {
    volume: number;
    muted: boolean;
    fadeIn: number;
    fadeOut: number;
    afterAction: VideoAfterAction;
    stopBehavior: 'black' | 'freeze';
  };
  crossfade: { enabled: boolean; duration: number };
  splash: { enabled: boolean; text: string; imagePath: string };
  player: { volume: number; muted: boolean; shuffle: boolean; repeat: RepeatMode };
}

// ─── Мост Electron <-> сервер ────────────────────────────────────────────────

export interface ElectronBridge {
  readonly electronAvailable: boolean;
  getDisplays(): DisplayInfo[];
  refreshDisplays(): DisplayInfo[];
  moveStageToDisplay(displayId: number): { ok: boolean; error?: string };
  setStageFullscreen(on: boolean): void;
  isStageFullscreen(): boolean;
  openStageWindow(): void;
  closeStageWindow(): void;
  isStageWindowOpen(): boolean;
  pickFolder(): Promise<string | null>;
  pickFiles(kind: 'music' | 'video' | 'sound' | 'image' | 'any'): Promise<string[]>;
  showInFolder(p: string): void;
  /** Регистрирует глобальные хоткеи; возвращает список занятых. */
  registerHotkeys(map: Record<string, string>): string[];
  clearHotkeys(): void;
  /** Callbacks от main-процесса к серверу. */
  setCallbacks(cb: {
    onDisplayRemoved: () => void;
    onDisplaysChanged: () => void;
    onHotkey: (buttonId: string) => void;
    onStageWindowClosed: () => void;
    onPortChanged: (port: number) => void;
  }): void;
}

// ─── WebSocket ───────────────────────────────────────────────────────────────

export type WsOut =
  | { type: 'snapshot'; snapshot: Snapshot }
  | { type: 'command'; target: 'renderer' | 'stage' | 'all'; domain: 'player' | 'stage' | 'eq' | 'soundboard'; action: string; payload?: unknown }
  | { type: 'toast'; level: 'info' | 'success' | 'error'; message: string }
  | { type: 'hello'; version: number; electron: boolean };

export type WsIn =
  | { type: 'report'; domain: 'player' | 'stage'; data: Record<string, unknown> }
  | { type: 'hello' };

// ─── Утилиты ─────────────────────────────────────────────────────────────────

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export function clampFade(v: number): number {
  return clamp(Math.round(v * 10) / 10, 0, MAX_FADE_SECONDS);
}

export function formatTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return (h > 0 ? h + ':' : '') + mm + ':' + String(s).padStart(2, '0');
}
