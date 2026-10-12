import { BrowserWindow, app, screen, dialog, Menu } from 'electron';
import { startSonicServer, RunningServer } from '../server/index';
import { createMainWindow, StageWindowManager } from './windows';
import { watchDisplays } from './displays';
import { createBridge } from './bridge';
import { setupIpc } from './ipc';
import { clearHotkeys } from './shortcuts';

/**
 * Точка входа Electron-приложения.
 * Порядок запуска: ready → сервер (внутри main-процесса) → главное окно → дисплеи.
 * При завершении: снятие глобальных хоткеев, остановка сервера.
 */

let server: RunningServer | null = null;
let stageManager: StageWindowManager | null = null;
let unregisterDisplayWatch: (() => void) | null = null;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

app.on('second-instance', () => {
  const wins = BrowserWindow.getAllWindows();
  if (wins.length > 0) {
    const main = wins[0];
    if (main.isMinimized()) main.restore();
    main.focus();
  }
});

// Автовоспроизведение без жеста пользователя (переключение треков программное)
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

app.whenReady().then(async () => {
  stageManager = new StageWindowManager(() => server?.port ?? 8765);
  const bridge = createBridge({ getServerPort: () => server?.port ?? 0, stage: stageManager });

  // Колбэки main → сервер настраиваем до старта, с ленивым доступом к контексту
  bridge.setCallbacks({
    onDisplayRemoved: () => server?.ctx.stage.onDisplayRemoved(),
    onDisplaysChanged: () => server?.ctx.stage.onDisplaysChanged(),
    onHotkey: (buttonId: string) => {
      server?.ctx.ws.broadcast({
        type: 'command', target: 'all', domain: 'soundboard', action: 'trigger', payload: { buttonId }
      });
    },
    onStageWindowClosed: () => server?.ctx.stage.onStageWindowClosed(),
    onPortChanged: (_port: number) => { /* окно перезагружается через reloadIfNeeded */ }
  });

  setupIpc(stageManager);

  try {
    server = await startSonicServer({
      electron: true,
      bridge,
      appVersion: app.getVersion()
    });
  } catch (err) {
    dialog.showErrorBox(
      'Sonic Studio',
      'Не удалось запустить локальный сервер.\n\n' +
      'Возможные причины: порт занят другой программой или нет доступа к папке данных.\n\n' +
      'Подробности: ' + (err as Error).message
    );
    app.quit();
    return;
  }

  unregisterDisplayWatch = watchDisplays({
    onDisplayRemoved: () => server?.ctx.stage.onDisplayRemoved(),
    onDisplaysChanged: () => server?.ctx.stage.onDisplaysChanged()
  });

  const isDev = process.env.SONIC_DEV === '1';
  const vitePort = process.env.SONIC_VITE_PORT || '5173';
  const winOpts = {
    port: server.port,
    isDev,
    devUrl: isDev ? `http://localhost:${vitePort}/?api=http://127.0.0.1:${server.port}` : null
  };
  createMainWindow(winOpts);

  Menu.setApplicationMenu(null);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow({ ...winOpts, port: server!.port });
    }
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  try { unregisterDisplayWatch?.(); } catch { /* ignore */ }
  try { clearHotkeys(); } catch { /* ignore */ }
  try { stageManager?.destroy(); } catch { /* ignore */ }
  void server?.close();
});

app.on('ready', () => {
  if (screen.getAllDisplays().length === 0) {
    console.warn('Дисплеи не обнаружены на момент запуска');
  }
});
