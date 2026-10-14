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
      // ФОНОВОЕ сохранение НИКОГДА не бросает исключений: на Windows антивирус
      // может кратковременно блокировать файл. Падение здесь убивало весь сервер
      // (главное окно продолжало работать из кэша — «Нет соединения с сервером»).
      this.saveSafe();
    }, this.delayMs);
  }

  /** Фоновое сохранение: без исключений, до 5 повторов при блокировке файла. */
  saveSafe(): void {
    if (this.tryWrite()) return;
    let attempts = 0;
    const retry = (): void => {
      if (this.tryWrite() || ++attempts >= 5) return;
      const t = setTimeout(retry, 250 * (attempts + 1));
      (t as unknown as { unref?: () => void }).unref?.();
    };
    const t = setTimeout(retry, 250);
    (t as unknown as { unref?: () => void }).unref?.();
  }

  private tryWrite(): boolean {
    try {
      this.writeSync();
      return true;
    } catch (err) {
      console.warn(`[Sonic] Сохранение не удалось, будет повтор: ${(err as Error).message} (${this.file})`);
      return false;
    }
  }

  private writeSync(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this._data, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  /** Синхронная запись. Бросает исключение — вызывайте в try/catch. */
  saveNow(): void {
    this.writeSync();
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
