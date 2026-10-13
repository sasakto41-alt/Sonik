import * as fs from 'fs';
import * as path from 'path';
import { ImageAsset, IMAGE_EXTS } from '../shared/types';
import { JsonStore } from './store';
import { AppPaths } from './paths';
import { uuid, extOf } from './util';
import { Logger } from './logger';

interface ImagesDb { images: ImageAsset[] }

/**
 * Библиотека картинок для сценического вывода.
 * Источники:
 *  - папки картинок из настроек (settings.imageFolders) — сканируются по запросу;
 *  - отдельные файлы, выбранные через проводник (добавляются в список навсегда).
 * Файлы не копируются: стримятся из своих папок (как музыка и видео).
 */
export class ImageLibrary {
  private db: JsonStore<ImagesDb>;
  private log: Logger;

  constructor(paths: AppPaths, log: Logger) {
    this.log = log;
    this.db = new JsonStore<ImagesDb>(path.join(paths.database, 'images.json'), { images: [] }, 400);
  }

  get images(): ImageAsset[] { return this.db.data.images; }

  byId(id: string): ImageAsset | undefined {
    return this.db.data.images.find(i => i.id === id);
  }

  byPath(p: string): ImageAsset | undefined {
    const norm = path.resolve(p).toLowerCase();
    return this.db.data.images.find(i => path.resolve(i.path).toLowerCase() === norm);
  }

  saveNow(): void { this.db.saveNow(); }

  list(): ImageAsset[] {
    return [...this.db.data.images].sort((a, b) => a.title.localeCompare(b.title, 'ru'));
  }

  /** Добавить отдельные файлы (выбор через проводник или API). */
  addFiles(pathsList: string[]): { added: number; updated: number; errors: string[] } {
    const res = { added: 0, updated: 0, errors: [] as string[] };
    for (const p of pathsList) {
      if (!fs.existsSync(p) || !IMAGE_EXTS.includes(extOf(p).toLowerCase())) {
        res.errors.push(`Пропущен неподдерживаемый файл: ${path.basename(p)}`);
        continue;
      }
      if (this.byPath(p)) { res.updated++; continue; }
      this.db.data.images.push(this.blank(p));
      res.added++;
    }
    this.db.scheduleSave();
    return res;
  }

  /** Сканирование папок картинок из настроек: новые добавляем, пропавшие помечаем. */
  scan(folders: string[]): { added: number; errors: string[] } {
    const res = { added: 0, errors: [] as string[] };
    const files: string[] = [];
    for (const f of folders) {
      if (!fs.existsSync(f)) { res.errors.push(`Папка недоступна: ${f}`); continue; }
      this.walk(f, files);
    }
    for (const p of files) {
      if (!this.byPath(p)) {
        this.db.data.images.push(this.blank(p));
        res.added++;
      }
    }
    for (const img of this.db.data.images) {
      const key = path.resolve(img.path).toLowerCase();
      const inFolders = files.some(f => path.resolve(f).toLowerCase() === key);
      if (!inFolders) img.missing = !fs.existsSync(img.path);
      else if (img.missing) img.missing = false;
    }
    this.db.scheduleSave();
    return res;
  }

  private walk(dir: string, out: string[], depth = 0): void {
    if (depth > 8) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      this.log.warn(`Скан картинок: папка недоступна ${dir}: ${(err as Error).message}`);
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) this.walk(full, out, depth + 1);
      else if (e.isFile() && IMAGE_EXTS.includes(extOf(e.name).toLowerCase())) out.push(full);
    }
  }

  private blank(p: string): ImageAsset {
    const st = fs.statSync(p);
    const ext = extOf(p).toLowerCase();
    return {
      id: uuid(),
      path: p,
      title: path.basename(p, ext),
      format: ext.slice(1),
      size: st.size,
      mtime: st.mtimeMs,
      missing: false,
      addedAt: Date.now()
    };
  }

  remove(id: string): boolean {
    const i = this.db.data.images.findIndex(img => img.id === id);
    if (i < 0) return false;
    this.db.data.images.splice(i, 1);
    this.db.scheduleSave();
    return true;
  }
}
