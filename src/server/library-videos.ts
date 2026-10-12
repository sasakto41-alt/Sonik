import * as fs from 'fs';
import * as path from 'path';
import { VideoItem, VIDEO_EXTS, VideoAfterAction } from '../shared/types';
import { JsonStore } from './store';
import { AppPaths } from './paths';
import { uuid, extOf } from './util';
import { Logger } from './logger';
import { defaultSettings } from './settings';

interface VideosDb { videos: VideoItem[] }
interface HistoryDb { items: { id: string; title: string; subtitle: string; at: number }[] }

export class VideoCatalog {
  private db: JsonStore<VideosDb>;
  private historyDb: JsonStore<HistoryDb>;
  private defaults: ReturnType<typeof defaultSettings>['defaults'];
  private log: Logger;

  constructor(paths: AppPaths, log: Logger) {
    this.log = log;
    this.defaults = defaultSettings().defaults;
    this.db = new JsonStore<VideosDb>(path.join(paths.database, 'videos.json'), { videos: [] }, 400);
    this.historyDb = new JsonStore<HistoryDb>(path.join(paths.database, 'history-videos.json'), { items: [] }, 800);
  }

  get videos(): VideoItem[] { return this.db.data.videos; }

  byId(id: string): VideoItem | undefined {
    return this.db.data.videos.find(v => v.id === id);
  }

  byPath(p: string): VideoItem | undefined {
    const norm = path.resolve(p).toLowerCase();
    return this.db.data.videos.find(v => path.resolve(v.path).toLowerCase() === norm);
  }

  saveNow(): void { this.db.saveNow(); }

  list(opts: { search?: string; sort?: string; order?: string } = {}): VideoItem[] {
    let arr = [...this.db.data.videos];
    const search = (opts.search || '').trim().toLowerCase();
    if (search) arr = arr.filter(v => v.title.toLowerCase().includes(search));
    const dir = opts.order === 'asc' ? 1 : -1;
    const sort = opts.sort || 'added';
    arr.sort((a, b) => {
      let r = 0;
      switch (sort) {
        case 'title': r = a.title.localeCompare(b.title, 'ru'); break;
        case 'duration': r = a.duration - b.duration; break;
        case 'lastPlayed': r = (a.lastPlayedAt || 0) - (b.lastPlayedAt || 0); break;
        default: r = a.addedAt - b.addedAt;
      }
      return r * dir;
    });
    return arr;
  }

  addFiles(pathsList: string[]): { added: number; updated: number; errors: string[] } {
    const res = { added: 0, updated: 0, errors: [] as string[] };
    for (const p of pathsList) {
      if (!fs.existsSync(p) || !VIDEO_EXTS.includes(extOf(p))) {
        res.errors.push(`Пропущен неподдерживаемый файл: ${path.basename(p)}`);
        continue;
      }
      if (this.byPath(p)) { res.updated++; continue; }
      this.db.data.videos.push(this.blank(p));
      res.added++;
    }
    this.db.scheduleSave();
    return res;
  }

  scan(folders: string[], onProgress?: (n: number, total: number, current: string) => void): { added: number; errors: string[] } {
    const res = { added: 0, errors: [] as string[] };
    const files: string[] = [];
    for (const f of folders) {
      if (!fs.existsSync(f)) { res.errors.push(`Папка недоступна: ${f}`); continue; }
      this.walk(f, files);
    }
    let i = 0;
    for (const p of files) {
      i++;
      onProgress?.(i, files.length, path.basename(p));
      if (!this.byPath(p)) {
        this.db.data.videos.push(this.blank(p));
        res.added++;
      }
    }
    for (const v of this.db.data.videos) {
      const key = path.resolve(v.path).toLowerCase();
      if (!files.some(f => path.resolve(f).toLowerCase() === key)) {
        v.missing = !fs.existsSync(v.path);
      } else if (v.missing) {
        v.missing = false;
      }
    }
    this.db.scheduleSave();
    return res;
  }

  private walk(dir: string, out: string[], depth = 0): void {
    if (depth > 8) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) this.walk(full, out, depth + 1);
      else if (e.isFile() && VIDEO_EXTS.includes(extOf(e.name))) out.push(full);
    }
  }

  private blank(p: string): VideoItem {
    const st = fs.statSync(p);
    const d = this.defaults;
    return {
      id: uuid(),
      path: p,
      title: path.basename(p, extOf(p)),
      duration: 0,
      format: extOf(p).slice(1),
      size: st.size,
      mtime: st.mtimeMs,
      missing: false,
      volume: d.volume,
      muted: d.muted,
      startPosition: 0,
      repeat: false,
      fadeIn: d.fadeIn,
      fadeOut: d.fadeOut,
      afterAction: d.afterAction,
      stopBehavior: d.stopBehavior,
      addedAt: Date.now()
    };
  }

  updateSettings(id: string, patch: Partial<VideoItem>): VideoItem | undefined {
    const v = this.byId(id);
    if (!v) return undefined;
    const allowed: (keyof VideoItem)[] = ['volume', 'muted', 'startPosition', 'endPosition', 'repeat',
      'fadeIn', 'fadeOut', 'afterAction', 'stopBehavior', 'nextVideoId', 'displayId', 'title', 'lastPosition', 'duration'];
    for (const key of allowed) {
      if (key in patch) (v as unknown as Record<string, unknown>)[key as string] = patch[key];
    }
    this.db.scheduleSave();
    return v;
  }

  /** Миниатюра меняется только сервером (после загрузки кадра). */
  setThumbFile(id: string, fileName: string): VideoItem | undefined {
    const v = this.byId(id);
    if (!v) return undefined;
    v.thumbFile = path.basename(fileName);
    this.db.scheduleSave();
    return v;
  }

  remove(id: string): boolean {
    const i = this.db.data.videos.findIndex(v => v.id === id);
    if (i < 0) return false;
    this.db.data.videos.splice(i, 1);
    this.db.scheduleSave();
    return true;
  }

  addHistory(v: VideoItem): void {
    const items = this.historyDb.data.items;
    items.unshift({ id: v.id, title: v.title, subtitle: v.format.toUpperCase(), at: Date.now() });
    if (items.length > 500) items.length = 500;
    v.lastPlayedAt = Date.now();
    this.historyDb.scheduleSave();
    this.db.scheduleSave();
  }

  getHistory(): { id: string; title: string; subtitle: string; at: number }[] {
    return this.historyDb.data.items;
  }
}
