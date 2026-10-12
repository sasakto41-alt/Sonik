import * as fs from 'fs';
import * as path from 'path';
import { Track, AUDIO_EXTS } from '../shared/types';
import { JsonStore } from './store';
import { AppPaths } from './paths';
import { uuid, extOf } from './util';
import { Logger } from './logger';

interface MusicDb { tracks: Track[] }
interface HistoryDb { items: { id: string; title: string; subtitle: string; at: number }[] }

export interface ScanResult { added: number; updated: number; removed: number; errors: string[] }

function walk(dir: string, exts: string[], out: string[], depth = 0): void {
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
    if (e.isDirectory()) {
      walk(full, exts, out, depth + 1);
    } else if (e.isFile() && exts.includes(extOf(e.name))) {
      out.push(full);
    }
  }
}

function titleFromFilename(p: string): string {
  return path.basename(p, extOf(p)).replace(/[_]+/g, ' ').trim() || path.basename(p);
}

export class MusicCatalog {
  private db: JsonStore<MusicDb>;
  private historyDb: JsonStore<HistoryDb>;
  private log: Logger;

  constructor(paths: AppPaths, log: Logger) {
    this.log = log;
    this.db = new JsonStore<MusicDb>(path.join(paths.database, 'music.json'), { tracks: [] }, 400);
    this.historyDb = new JsonStore<HistoryDb>(path.join(paths.database, 'history-music.json'), { items: [] }, 800);
  }

  get tracks(): Track[] { return this.db.data.tracks; }
  get revisionFiles(): string { return 'music'; }

  byId(id: string): Track | undefined {
    return this.db.data.tracks.find(t => t.id === id);
  }

  byPath(p: string): Track | undefined {
    const norm = path.resolve(p).toLowerCase();
    return this.db.data.tracks.find(t => path.resolve(t.path).toLowerCase() === norm);
  }

  saveNow(): void { this.db.saveNow(); }

  list(opts: { search?: string; sort?: string; order?: string; favorite?: boolean } = {}): Track[] {
    let arr = [...this.db.data.tracks];
    const search = (opts.search || '').trim().toLowerCase();
    if (search) {
      arr = arr.filter(t =>
        t.title.toLowerCase().includes(search) ||
        t.artist.toLowerCase().includes(search) ||
        t.album.toLowerCase().includes(search));
    }
    if (opts.favorite) arr = arr.filter(t => t.favorite);
    const sort = opts.sort || 'added';
    const dir = opts.order === 'asc' ? 1 : -1;
    arr.sort((a, b) => {
      let r = 0;
      switch (sort) {
        case 'title': r = a.title.localeCompare(b.title, 'ru'); break;
        case 'artist': r = a.artist.localeCompare(b.artist, 'ru'); break;
        case 'album': r = a.album.localeCompare(b.album, 'ru'); break;
        case 'duration': r = a.duration - b.duration; break;
        case 'lastPlayed': r = (a.lastPlayedAt || 0) - (b.lastPlayedAt || 0); break;
        default: r = a.addedAt - b.addedAt;
      }
      if (r === 0) r = a.title.localeCompare(b.title, 'ru');
      return r * dir;
    });
    return arr;
  }

  /** Импорт отдельных файлов (без копирования — файлы остаются на месте). */
  async addFiles(pathsList: string[], coversDir: string): Promise<ScanResult> {
    const res: ScanResult = { added: 0, updated: 0, removed: 0, errors: [] };
    for (const p of pathsList) {
      try {
        if (!fs.existsSync(p) || !AUDIO_EXTS.includes(extOf(p))) {
          res.errors.push(`Пропущен неподдерживаемый файл: ${path.basename(p)}`);
          continue;
        }
        const existing = this.byPath(p);
        if (existing) {
          await this.applyMetadata(existing, p, coversDir);
          res.updated++;
        } else {
          const t = this.blank(p);
          await this.applyMetadata(t, p, coversDir);
          this.db.data.tracks.push(t);
          res.added++;
        }
      } catch (err) {
        res.errors.push(`${path.basename(p)}: ${(err as Error).message}`);
      }
    }
    this.db.scheduleSave();
    return res;
  }

  /** Сканирование каталогов. */
  async scan(folders: string[], coversDir: string, onProgress?: (processed: number, total: number, current: string) => void): Promise<ScanResult> {
    const res: ScanResult = { added: 0, updated: 0, removed: 0, errors: [] };
    const files: string[] = [];
    for (const f of folders) {
      if (!fs.existsSync(f)) { res.errors.push(`Папка недоступна: ${f}`); continue; }
      walk(f, AUDIO_EXTS, files);
    }
    const known = new Map(this.db.data.tracks.map(t => [path.resolve(t.path).toLowerCase(), t]));
    const seen = new Set<string>();
    let i = 0;
    for (const p of files) {
      i++;
      const key = path.resolve(p).toLowerCase();
      seen.add(key);
      onProgress?.(i, files.length, path.basename(p));
      try {
        const existing = known.get(key);
        if (existing) {
          const st = fs.statSync(p);
          if (st.mtimeMs > existing.mtime) {
            await this.applyMetadata(existing, p, coversDir);
            res.updated++;
          }
        } else {
          const t = this.blank(p);
          await this.applyMetadata(t, p, coversDir);
          this.db.data.tracks.push(t);
          res.added++;
        }
      } catch (err) {
        res.errors.push(`${path.basename(p)}: ${(err as Error).message}`);
      }
    }
    // Отмечаем отсутствующие файлы (не удаляем — пользователь мог отключить диск)
    for (const t of this.db.data.tracks) {
      const key = path.resolve(t.path).toLowerCase();
      if (!seen.has(key)) {
        t.missing = !fs.existsSync(t.path);
        if (t.missing) res.removed++;
      } else if (t.missing) {
        t.missing = false;
      }
    }
    this.db.scheduleSave();
    return res;
  }

  remove(id: string): boolean {
    const i = this.db.data.tracks.findIndex(t => t.id === id);
    if (i < 0) return false;
    this.db.data.tracks.splice(i, 1);
    this.db.scheduleSave();
    return true;
  }

  setFavorite(id: string, v: boolean): boolean {
    const t = this.byId(id);
    if (!t) return false;
    t.favorite = v;
    this.db.scheduleSave();
    return true;
  }

  private blank(p: string): Track {
    const st = fs.statSync(p);
    return {
      id: uuid(),
      path: p,
      title: titleFromFilename(p),
      artist: 'Неизвестный исполнитель',
      album: '',
      duration: 0,
      format: extOf(p).slice(1),
      size: st.size,
      mtime: st.mtimeMs,
      favorite: false,
      missing: false,
      addedAt: Date.now(),
      playCount: 0
    };
  }

  private async applyMetadata(t: Track, p: string, coversDir: string): Promise<void> {
    const st = fs.statSync(p);
    t.size = st.size;
    t.mtime = st.mtimeMs;
    t.missing = false;
    t.format = extOf(p).slice(1);
    let meta: { title?: string; artist?: string; album?: string; duration?: number; coverFormat?: string; coverData?: Buffer } = {};
    try {
      // Динамический импорт, чтобы отсутствие пакета не роняло сервер
      const mm = await import('music-metadata');
      const m = await mm.parseFile(p, { duration: true, skipCovers: false });
      meta = {
        title: m.common.title || undefined,
        artist: m.common.artist || m.common.albumartist || undefined,
        album: m.common.album || undefined,
        duration: m.format.duration || undefined,
        coverFormat: m.common.picture && m.common.picture[0] ? m.common.picture[0].format : undefined,
        coverData: m.common.picture && m.common.picture[0] ? m.common.picture[0].data : undefined
      };
    } catch {
      // Некорректные метаданные — используем имя файла
    }
    if (meta.title) t.title = meta.title;
    if (meta.artist) t.artist = meta.artist;
    if (meta.album) t.album = meta.album;
    if (meta.duration && isFinite(meta.duration)) t.duration = meta.duration;
    if (meta.coverData && meta.coverData.length > 0) {
      try {
        const ext = (meta.coverFormat || 'image/jpeg').includes('png') ? '.png' : '.jpg';
        const coverName = `cover-${t.id}${ext}`;
        fs.writeFileSync(path.join(coversDir, coverName), meta.coverData);
        t.coverFile = coverName;
      } catch {
        /* обложка не критична */
      }
    }
  }

  addHistory(track: Track): void {
    const items = this.historyDb.data.items;
    items.unshift({ id: track.id, title: track.title, subtitle: track.artist, at: Date.now() });
    if (items.length > 500) items.length = 500;
    track.playCount += 1;
    track.lastPlayedAt = Date.now();
    this.historyDb.scheduleSave();
    this.db.scheduleSave();
  }

  getHistory(): { id: string; title: string; subtitle: string; at: number }[] {
    return this.historyDb.data.items;
  }
}
