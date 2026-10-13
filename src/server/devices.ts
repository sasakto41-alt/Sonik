import * as path from 'path';
import { DeviceEntry, DeviceType } from '../shared/types';
import { JsonStore } from './store';
import { AppPaths } from './paths';

interface DevicesFile {
  devices: PersistedDevice[];
}

interface PersistedDevice {
  id: string;
  name: string;
  type: DeviceType;
  ua: string;
  ip: string;
  firstSeen: number;
  lastSeen: number;
  paired: boolean;
  pairedAt: number | null;
}

/**
 * Реестр устройств вывода (телефоны, планшеты, ТВ — веб-клиенты сайта).
 *
 * Принципы:
 *  - устройство создаётся автоматически при первом подключении к сайту
 *    и сразу сохраняется на диск — ничего не теряется;
 *  - подключение подтверждается кодом (PIN из настроек сервера);
 *  - список живёт в settings/devices.json и переживает перезапуск приложения.
 */
export class DeviceManager {
  private store: JsonStore<DevicesFile>;

  constructor(paths: AppPaths, private getPin: () => string) {
    this.store = new JsonStore<DevicesFile>(path.join(paths.settings, 'devices.json'), { devices: [] }, 300);
  }

  /** Список сохранённых устройств (без вычисляемых флагов). */
  list(): DeviceEntry[] {
    return this.store.data.devices.map(d => this.toEntry(d));
  }

  /** Список с вычисленными флагами online / showsStage. */
  withOnline(onlineIds: Set<string>, stageIds: Set<string>): DeviceEntry[] {
    return this.store.data.devices
      .map(d => ({ ...this.toEntry(d), online: onlineIds.has(d.id), showsStage: stageIds.has(d.id) }))
      .sort((a, b) => {
        if (a.online !== b.online) return a.online ? -1 : 1;
        if (a.paired !== b.paired) return a.paired ? -1 : 1;
        return b.lastSeen - a.lastSeen;
      });
  }

  byId(id: string): PersistedDevice | undefined {
    return this.store.data.devices.find(d => d.id === id);
  }

  /**
   * Регистрирует/обновляет устройство. Создаётся автоматически при первом
   * подключении — и сразу сохраняется, чтобы «сделал всё, а не сохранилось»
   * не повторялось.
   */
  touch(id: string, meta: { ua: string; ip: string }): DeviceEntry {
    const now = Date.now();
    let d = this.byId(id);
    if (!d) {
      const type = detectDeviceType(meta.ua);
      d = {
        id,
        name: uniqueName(this.store.data.devices, deviceName(meta.ua, type)),
        type,
        ua: meta.ua || '',
        ip: meta.ip || '',
        firstSeen: now,
        lastSeen: now,
        paired: false,
        pairedAt: null
      };
      this.store.data.devices.push(d);
    } else {
      d.lastSeen = now;
      if (meta.ip) d.ip = meta.ip;
      if (meta.ua && meta.ua !== d.ua) {
        d.ua = meta.ua;
        d.type = detectDeviceType(meta.ua);
      }
    }
    this.store.scheduleSave();
    return this.toEntry(d);
  }

  /** Подтверждение устройства кодом (PIN). */
  pair(id: string, pin: string): { ok: boolean; error?: string; device?: DeviceEntry } {
    const d = this.byId(id);
    if (!d) return { ok: false, error: 'Устройство не найдено. Откройте сайт Sonic Studio на нём — оно появится в списке автоматически.' };
    const expected = String(this.getPin() || '');
    if (!expected || pin !== expected) return { ok: false, error: 'Неверный код подключения. Код отображается в настройках — «Сервер и доступ».' };
    d.paired = true;
    d.pairedAt = Date.now();
    this.store.scheduleSave();
    return { ok: true, device: this.toEntry(d) };
  }

  unpair(id: string): DeviceEntry | null {
    const d = this.byId(id);
    if (!d) return null;
    d.paired = false;
    d.pairedAt = null;
    this.store.scheduleSave();
    return this.toEntry(d);
  }

  rename(id: string, name: string): DeviceEntry | null {
    const d = this.byId(id);
    const clean = name.trim().slice(0, 40);
    if (!d || !clean) return null;
    d.name = clean;
    this.store.scheduleSave();
    return this.toEntry(d);
  }

  remove(id: string): boolean {
    const before = this.store.data.devices.length;
    this.store.data.devices = this.store.data.devices.filter(d => d.id !== id);
    if (this.store.data.devices.length !== before) {
      this.store.scheduleSave();
      return true;
    }
    return false;
  }

  saveNow(): void {
    try { this.store.saveNow(); } catch { /* ignore */ }
  }

  private toEntry(d: PersistedDevice): DeviceEntry {
    return { ...d, online: false, showsStage: false };
  }
}

// ─── Определение типа и имени устройства по User-Agent ──────────────────────

export function detectDeviceType(ua: string): DeviceType {
  const s = (ua || '').toLowerCase();
  if (!s) return 'web';
  if (/crkey|googletv|androidtv|bravia|smart-tv|smarttv|appletv|webos|tizen|hbbtv|netcast/.test(s)) return 'tv';
  if (/ipad|tablet|playbook|silk|kindle/.test(s)) return 'tablet';
  if (/iphone|ipod|android.+mobile|windows phone|mobile/.test(s)) return 'phone';
  if (/windows|macintosh|mac os x|cros|linux x86_64|ubuntu|fedora/.test(s)) return 'desktop';
  return 'web';
}

export function deviceName(ua: string, type: DeviceType): string {
  const s = (ua || '').toLowerCase();
  if (/iphone/.test(s)) return 'iPhone';
  if (/ipad/.test(s)) return 'iPad';
  if (type === 'tv') return 'ТВ-приставка';
  if (/android/.test(s)) return type === 'phone' ? 'Android-телефон' : 'Android-планшет';
  if (/windows/.test(s)) return 'Windows-ПК';
  if (/macintosh|mac os/.test(s)) return 'Mac';
  if (/cros/.test(s)) return 'Chromebook';
  if (/linux/.test(s)) return 'Linux-ПК';
  switch (type) {
    case 'phone': return 'Телефон';
    case 'tablet': return 'Планшет';
    case 'desktop': return 'Компьютер';
    default: return 'Браузер';
  }
}

function uniqueName(existing: PersistedDevice[], base: string): string {
  const names = new Set(existing.map(d => d.name));
  if (!names.has(base)) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base} ${i}`;
    if (!names.has(candidate)) return candidate;
  }
  return base + ' ' + Date.now().toString(36);
}
