import { BrowserWindow, app } from 'electron';
import * as path from 'path';
import { moveWindowToDisplay } from './displays';

/**
 * Управление окнами: главное окно и окно сценического вывода (Stage Output).
 * В окне сцены нет никакого интерфейса управления — только контент для зрителей.
 */

/**
 * Загрузка окна с повторной попыткой: если внутренний сервер ещё поднимается,
 * отказ загрузки не остаётся необработанным (раньше это роняло приложение).
 */
function loadWithRetry(win: BrowserWindow, url: string, attempt = 0): void {
  win.loadURL(url).catch((err) => {
    console.error(`[Sonic] Не удалось загрузить ${url}: ${(err as Error).message}`);
    if (attempt < 5 && !win.isDestroyed()) {
      setTimeout(() => { if (!win.isDestroyed()) loadWithRetry(win, url, attempt + 1); }, 1000);
    }
  });
}

export function createMainWindow(opts: { port: number; isDev: boolean; devUrl: string | null }): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0e1014',
    show: false,
    title: 'Sonic Studio',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false
    }
  });

  if (opts.isDev && opts.devUrl) {
    loadWithRetry(win, opts.devUrl);
    win.webContents.openDevTools({ mode: 'bottom' });
  } else {
    loadWithRetry(win, `http://127.0.0.1:${opts.port}/`);
  }

  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { /* окно закрыто */ });
  return win;
}

export class StageWindowManager {
  private win: BrowserWindow | null = null;
  private onClosedCb: (() => void) | null = null;

  constructor(private getPort: () => number) {}

  onClosed(cb: () => void): void {
    this.onClosedCb = cb;
  }

  ensure(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win;
    this.win = new BrowserWindow({
      width: 1280,
      height: 720,
      backgroundColor: '#000000',
      show: false,
      title: 'Sonic Studio — Stage Output',
      autoHideMenuBar: true,
      fullscreenable: true,
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: false
      }
    });
    void loadWithRetry(this.win, `http://127.0.0.1:${this.getPort()}/stage.html`);
    this.win.once('ready-to-show', () => {
      this.win?.show();
    });
    this.win.on('closed', () => {
      this.win = null;
      this.onClosedCb?.();
    });
    this.win.on('enter-full-screen', () => { /* состояние синхронизируется через сервер */ });
    return this.win;
  }

  isOpen(): boolean {
    return this.win !== null && !this.win.isDestroyed();
  }

  moveTo(displayId: number): { ok: boolean; error?: string } {
    if (!this.isOpen()) return { ok: true }; // окно позиционируется при создании
    const win = this.win!;
    const wasFullscreen = win.isFullScreen();
    const r = moveWindowToDisplay(win, displayId, wasFullscreen);
    if (r.ok) {
      win.show();
      win.focus();
    }
    return r;
  }

  setFullscreen(on: boolean): void {
    if (!this.isOpen()) return;
    this.win!.setFullScreen(on);
  }

  isFullscreen(): boolean {
    return this.isOpen() ? this.win!.isFullScreen() : false;
  }

  close(): void {
    if (this.isOpen()) this.win!.close();
  }

  destroy(): void {
    this.close();
  }
}

export function getAppResourceNote(): string {
  return app.isPackaged ? 'packaged' : 'development';
}
