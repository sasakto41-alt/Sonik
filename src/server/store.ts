import * as fs from 'fs';
import * as path from 'path';

/**
 * JSON-хранилище с атомарной записью (tmp + rename) и отложенным сохранением.
 * Пользовательские данные не удаляются при обновлениях: при чтении поля
 * по умолчанию мягко дополняются (deepMerge).
 */
export class JsonStore<T extends object> {
  private _data: T;
  private timer: NodeJS.Timeout | null = null;
  private readonly delayMs: number;

  constructor(private file: string, private defaults: T, delayMs = 250) {
    this.delayMs = delayMs;
    this._data = this.load();
  }

  get data(): T {
    return this._data;
  }

  /** Мутация данных + планирование сохранения. */
  update(fn: (d: T) => void): void {
    fn(this._data);
    this.scheduleSave();
  }

  /** Немедленная мутация + синхронная запись на диск. */
  updateNow(fn: (d: T) => void): void {
    fn(this._data);
    this.saveNow();
  }

  scheduleSave(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.saveNow();
    }, this.delayMs);
  }

  saveNow(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this._data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (err) {
      throw new Error(`Не удалось сохранить настройки (${(err as Error).message})`);
    }
  }

  private load(): T {
    let raw: unknown = undefined;
    try {
      if (fs.existsSync(this.file)) {
        raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      }
    } catch {
      raw = undefined; // повреждённый файл — используем значения по умолчанию
    }
    if (raw === undefined || raw === null || typeof raw !== 'object') {
      return JSON.parse(JSON.stringify(this.defaults)) as T;
    }
    return JsonStore.deepMerge<T>(JSON.parse(JSON.stringify(this.defaults)) as T, raw as Record<string, unknown>);
  }

  static deepMerge<T>(base: T, src: Record<string, unknown>): T {
    for (const [key, value] of Object.entries(src)) {
      const b = (base as Record<string, unknown>)[key];
      if (value !== null && typeof value === 'object' && !Array.isArray(value) && b !== null && typeof b === 'object' && !Array.isArray(b)) {
        JsonStore.deepMerge(b as Record<string, unknown>, value as Record<string, unknown>);
      } else if (value !== undefined) {
        (base as Record<string, unknown>)[key] = value;
      }
    }
    return base;
  }
}
