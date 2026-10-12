import { screen, BrowserWindow } from 'electron';
import { DisplayInfo } from '../shared/types';

/**
 * Работа с реальными дисплеями Windows через Electron screen API.
 * Никаких фиктивных списков: информация берётся из screen.getAllDisplays().
 */

let stageBounds: { x: number; y: number; width: number; height: number } | null = null;

function boundsEqual(a: Electron.Rectangle, b: { x: number; y: number; width: number; height: number }): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

export function listDisplays(): DisplayInfo[] {
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  stageBounds = null;
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.getTitle().includes('Stage Output')) {
      stageBounds = win.getBounds();
    }
  }
  return displays.map((d, i) => ({
    id: d.id,
    label: `Дисплей ${i + 1}${d.id === primary.id ? ' (основной)' : ''}`,
    bounds: { ...d.bounds },
    workArea: { ...d.workArea },
    scaleFactor: d.scaleFactor,
    primary: d.id === primary.id,
    isStage: stageBounds !== null && boundsEqual(d.bounds, stageBounds),
    available: true
  }));
}

export function findDisplay(displayId: number): Electron.Display | undefined {
  return screen.getAllDisplays().find(d => d.id === displayId);
}

/**
 * Перемещает окно на выбранный дисплей, опционально в полноэкранный режим.
 * Возвращает понятную ошибку, если дисплей недоступен.
 */
export function moveWindowToDisplay(win: BrowserWindow, displayId: number, fullscreen: boolean): { ok: boolean; error?: string } {
  const display = findDisplay(displayId);
  if (!display) {
    return { ok: false, error: 'Выбранный дисплей недоступен (отключён или переподключён)' };
  }
  try {
    if (win.isFullScreen()) win.setFullScreen(false);
    const b = display.bounds;
    const size = win.getBounds();
    const w = Math.min(size.width, b.width);
    const h = Math.min(size.height, b.height);
    win.setBounds({
      x: b.x + Math.floor((b.width - w) / 2),
      y: b.y + Math.floor((b.height - h) / 2),
      width: w,
      height: h
    });
    win.moveTop();
    if (fullscreen) win.setFullScreen(true);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: 'Не удалось переместить окно вывода: ' + (err as Error).message };
  }
}

export function watchDisplays(cb: { onDisplayRemoved: () => void; onDisplaysChanged: () => void }): () => void {
  const removed = (_e: unknown, _d: Electron.Display): void => cb.onDisplayRemoved();
  const added = (): void => cb.onDisplaysChanged();
  const changed = (): void => cb.onDisplaysChanged();
  screen.on('display-removed', removed);
  screen.on('display-added', added);
  screen.on('display-metrics-changed', changed);
  return () => {
    screen.off('display-removed', removed);
    screen.off('display-added', added);
    screen.off('display-metrics-changed', changed);
  };
}
