import * as path from 'path';
import * as fs from 'fs';

export interface AppPaths {
  root: string;
  settings: string;
  playlists: string;
  soundboard: string;
  soundFiles: string;
  cache: string;
  covers: string;
  thumbs: string;
  exports: string;
  logs: string;
  database: string;
}

export function resolveDataDir(explicit?: string): string {
  if (explicit && explicit.trim()) return path.resolve(explicit.trim());
  if (process.env.SONIC_DATA_DIR && process.env.SONIC_DATA_DIR.trim()) {
    return path.resolve(process.env.SONIC_DATA_DIR.trim());
  }
  if (process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'SonicStudio');
  }
  const home = process.env.HOME || process.env.USERPROFILE || process.cwd();
  return path.join(home, '.sonic-studio');
}

export function ensurePaths(root: string): AppPaths {
  const p: AppPaths = {
    root,
    settings: path.join(root, 'settings'),
    playlists: path.join(root, 'playlists'),
    soundboard: path.join(root, 'soundboard'),
    soundFiles: path.join(root, 'soundboard', 'files'),
    cache: path.join(root, 'cache'),
    covers: path.join(root, 'cache', 'covers'),
    thumbs: path.join(root, 'cache', 'thumbs'),
    exports: path.join(root, 'cache', 'exports'),
    logs: path.join(root, 'logs'),
    database: path.join(root, 'database')
  };
  for (const dir of Object.values(p)) fs.mkdirSync(dir, { recursive: true });
  return p;
}
