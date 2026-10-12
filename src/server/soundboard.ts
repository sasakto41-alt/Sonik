import * as fs from 'fs';
import * as path from 'path';
import { SoundboardConfig, SoundButton, SoundSet } from '../shared/types';
import { JsonStore } from './store';
import { AppPaths } from './paths';
import { uuid, extOf, sanitizeFileName } from './util';

export class SoundboardManager {
  private db: JsonStore<SoundboardConfig>;

  constructor(private paths: AppPaths) {
    const defaults: SoundboardConfig = {
      sets: [{ id: 'default', name: 'Основной набор' }],
      buttons: []
    };
    this.db = new JsonStore<SoundboardConfig>(path.join(paths.soundboard, 'config.json'), defaults, 250);
  }

  get config(): SoundboardConfig { return this.db.data; }
  saveNow(): void { this.db.saveNow(); }

  /** Полное сохранение конфигурации (после изменений на клиенте). */
  replace(config: Partial<SoundboardConfig>): SoundboardConfig {
    if (Array.isArray(config.sets)) {
      this.db.data.sets = config.sets.filter(s => s && typeof s.id === 'string' && typeof s.name === 'string');
      if (this.db.data.sets.length === 0) this.db.data.sets = [{ id: 'default', name: 'Основной набор' }];
    }
    if (Array.isArray(config.buttons)) {
      const setIds = new Set(this.db.data.sets.map(s => s.id));
      this.db.data.buttons = config.buttons.filter(b =>
        b && typeof b.id === 'string' && typeof b.file === 'string' &&
        !b.file.includes('..') && !path.isAbsolute(b.file) &&
        typeof b.name === 'string');
      for (const b of this.db.data.buttons) {
        if (!setIds.has(b.setId)) b.setId = this.db.data.sets[0].id;
      }
    }
    this.db.scheduleSave();
    return this.db.data;
  }

  updateButton(id: string, patch: Partial<SoundButton>): SoundButton | undefined {
    const b = this.db.data.buttons.find(x => x.id === id);
    if (!b) return undefined;
    const allowed: (keyof SoundButton)[] = ['name', 'color', 'icon', 'volume', 'hotkey', 'mode', 'overlap', 'setId'];
    for (const k of allowed) {
      if (k in patch) (b as unknown as Record<string, unknown>)[k as string] = patch[k];
    }
    this.db.scheduleSave();
    return b;
  }

  addSet(name: string): SoundSet {
    const s: SoundSet = { id: uuid(), name: name.trim() || 'Новый набор' };
    this.db.data.sets.push(s);
    this.db.scheduleSave();
    return s;
  }

  renameSet(id: string, name: string): SoundSet | undefined {
    const s = this.db.data.sets.find(x => x.id === id);
    if (!s) return undefined;
    s.name = name.trim() || s.name;
    this.db.scheduleSave();
    return s;
  }

  deleteSet(id: string): boolean {
    if (this.db.data.sets.length <= 1) return false;
    const i = this.db.data.sets.findIndex(x => x.id === id);
    if (i < 0) return false;
    this.db.data.sets.splice(i, 1);
    this.db.data.buttons = this.db.data.buttons.filter(b => {
      if (b.setId === id) { this.removeFile(b.file); return false; }
      return true;
    });
    this.db.scheduleSave();
    return true;
  }

  /** Импорт файла с диска (desktop) — копия в каталог soundboard/files. */
  importFromPath(sourcePath: string, name?: string): SoundButton {
    if (!fs.existsSync(sourcePath)) throw new Error('Файл не найден');
    const ext = extOf(sourcePath);
    const fileName = `${uuid()}${ext}`;
    fs.copyFileSync(sourcePath, path.join(this.paths.soundFiles, fileName));
    const button: SoundButton = {
      id: uuid(),
      name: (name || path.basename(sourcePath, ext)).slice(0, 60),
      file: fileName,
      color: '#7c6cff',
      icon: 'sound',
      volume: 1,
      mode: 'once',
      overlap: true,
      setId: this.db.data.sets[0].id
    };
    this.db.data.buttons.push(button);
    this.db.scheduleSave();
    return button;
  }

  /** Импорт бинарных данных (веб-интерфейс / аудиоредактор). */
  importBinary(buf: Buffer, ext: string, name: string): SoundButton {
    const fileName = `${uuid()}${ext || '.wav'}`;
    fs.writeFileSync(path.join(this.paths.soundFiles, fileName), buf);
    const button: SoundButton = {
      id: uuid(),
      name: sanitizeFileName(name || 'Звук').slice(0, 60),
      file: fileName,
      color: '#7c6cff',
      icon: 'sound',
      volume: 1,
      mode: 'once',
      overlap: true,
      setId: this.db.data.sets[0].id
    };
    this.db.data.buttons.push(button);
    this.db.scheduleSave();
    return button;
  }

  removeButton(id: string): boolean {
    const i = this.db.data.buttons.findIndex(b => b.id === id);
    if (i < 0) return false;
    this.removeFile(this.db.data.buttons[i].file);
    this.db.data.buttons.splice(i, 1);
    this.db.scheduleSave();
    return true;
  }

  fileOf(buttonId: string): string | null {
    const b = this.db.data.buttons.find(x => x.id === buttonId);
    if (!b) return null;
    const p = path.join(this.paths.soundFiles, b.file);
    if (!fs.existsSync(p)) return null;
    return p;
  }

  private removeFile(fileName: string): void {
    try {
      const p = path.join(this.paths.soundFiles, path.basename(fileName));
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      /* не критично */
    }
  }
}
