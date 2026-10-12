import { contextBridge, ipcRenderer } from 'electron';

/**
 * Безопасный preload: только contextBridge + ipcRenderer (совместимо с sandbox).
 * Renderer не имеет доступа к Node — всё через явно перечисленные каналы.
 */
contextBridge.exposeInMainWorld('sonicDesktop', {
  isElectron: true,
  platform: process.platform,

  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickFolder'),
  pickFiles: (kind: 'music' | 'video' | 'sound' | 'any'): Promise<string[]> =>
    ipcRenderer.invoke('dialog:pickFiles', kind),

  setFullscreen: (on: boolean): Promise<boolean> => ipcRenderer.invoke('window:setFullscreen', on),
  isFullscreen: (): Promise<boolean> => ipcRenderer.invoke('window:isFullscreen'),
  closeStageWindow: (): Promise<boolean> => ipcRenderer.invoke('window:closeStage'),

  appInfo: (): Promise<{ platform: string; version: string; electron: boolean }> => ipcRenderer.invoke('app:info')
});
