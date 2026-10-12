import { globalShortcut } from 'electron';

/**
 * Глобальные (системные) горячие клавиши Soundboard.
 * Регистрация через Electron globalShortcut с обязательным снятием при завершении.
 */

type HotkeyMap = Map<string, string>; // accelerator -> buttonId
const registered: HotkeyMap = new Map();

export function registerHotkeys(
  map: Record<string, string>,
  onTrigger: (buttonId: string) => void
): string[] {
  clearHotkeys();
  const conflicts: string[] = [];
  for (const [buttonId, accelerator] of Object.entries(map)) {
    if (!accelerator) continue;
    try {
      const ok = globalShortcut.register(accelerator, () => onTrigger(buttonId));
      if (ok) {
        registered.set(accelerator, buttonId);
      } else {
        conflicts.push(accelerator);
      }
    } catch {
      conflicts.push(accelerator);
    }
  }
  return conflicts;
}

export function clearHotkeys(): void {
  for (const accel of registered.keys()) {
    try { globalShortcut.unregister(accel); } catch { /* ignore */ }
  }
  registered.clear();
}
