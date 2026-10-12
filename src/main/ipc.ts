import { ipcMain, dialog, BrowserWindow } from 'electron';
import { StageWindowManager } from './windows';

/**
 * Проверенные IPC-вызовы renderer ↔ main.
 * Каждому каналу соответствует явная валидация аргументов.
 */
export function setupIpc(stage: StageWindowManager): void {

  ipcMain.handle('dialog:pickFolder', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
  });

  ipcMain.handle('dialog:pickFiles', async (_e, kind: unknown) => {
    const filtersByKind: Record<string, Electron.FileFilter[]> = {
      music: [{ name: 'Аудио', extensions: ['mp3', 'wav', 'flac', 'ogg', 'oga', 'm4a', 'aac', 'opus'] }],
      video: [{ name: 'Видео', extensions: ['mp4', 'webm', 'm4v', 'mov', 'mkv', 'avi'] }],
      sound: [{ name: 'Аудио', extensions: ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac'] }],
      any: [{ name: 'Все файлы', extensions: ['*'] }]
    };
    const filters = filtersByKind[String(kind)] || filtersByKind.any;
    const r = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'], filters });
    return r.canceled ? [] : r.filePaths;
  });

  ipcMain.handle('window:setFullscreen', (_e, on: unknown) => {
    const win = BrowserWindow.fromWebContents(_e.sender);
    if (win && typeof on === 'boolean') win.setFullScreen(on);
    return win ? win.isFullScreen() : false;
  });

  ipcMain.handle('window:isFullscreen', (_e) => {
    const win = BrowserWindow.fromWebContents(_e.sender);
    return win ? win.isFullScreen() : false;
  });

  ipcMain.handle('window:closeStage', () => {
    stage.close();
    return true;
  });

  ipcMain.handle('app:info', () => ({
    platform: process.platform,
    version: process.env.npm_package_version || '1.0.0',
    electron: true
  }));
}
