import { dialog, shell } from 'electron';
import { ElectronBridge, AUDIO_EXTS, VIDEO_EXTS } from '../shared/types';
import { listDisplays, findDisplay, moveWindowToDisplay } from './displays';
import { StageWindowManager } from './windows';
import { registerHotkeys, clearHotkeys } from './shortcuts';

interface BridgeDeps {
  getServerPort: () => number;
  stage: StageWindowManager;
}

/**
 * Реализация ElectronBridge: связывает сервер (запущенный внутри main-процесса)
 * с окнами, дисплеями, диалогами и глобальными хоткеями.
 */
export function createBridge(deps: BridgeDeps): ElectronBridge {
  const audioFilters = [{ name: 'Аудио', extensions: AUDIO_EXTS.map(x => x.slice(1)) }, { name: 'Все файлы', extensions: ['*'] }];
  const videoFilters = [{ name: 'Видео', extensions: VIDEO_EXTS.map(x => x.slice(1)) }, { name: 'Все файлы', extensions: ['*'] }];
  const soundFilters = [{ name: 'Аудио', extensions: ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac'] }, { name: 'Все файлы', extensions: ['*'] }];

  let bridgeCallbacks: {
    onDisplayRemoved: () => void;
    onDisplaysChanged: () => void;
    onHotkey: (buttonId: string) => void;
    onStageWindowClosed: () => void;
    onPortChanged: (port: number) => void;
  } = {
    onDisplayRemoved: () => {},
    onDisplaysChanged: () => {},
    onHotkey: () => {},
    onStageWindowClosed: () => {},
    onPortChanged: () => {}
  };

  const bridge: ElectronBridge = {
    electronAvailable: true,

    getDisplays: () => listDisplays(),

    refreshDisplays: () => listDisplays(),

    moveStageToDisplay: (displayId: number) => {
      const display = findDisplay(displayId);
      if (!display) return { ok: false, error: 'Выбранный дисплей недоступен' };
      if (!deps.stage.isOpen()) deps.stage.ensure();
      return deps.stage.moveTo(displayId);
    },

    setStageFullscreen: (on: boolean) => deps.stage.setFullscreen(on),

    isStageFullscreen: () => deps.stage.isFullscreen(),

    openStageWindow: () => {
      deps.stage.ensure();
    },

    closeStageWindow: () => deps.stage.close(),

    isStageWindowOpen: () => deps.stage.isOpen(),

    pickFolder: async () => {
      const r = await dialog.showOpenDialog({ properties: ['openDirectory'] });
      return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
    },

    pickFiles: async (kind) => {
      const filters =
        kind === 'music' ? audioFilters :
        kind === 'video' ? videoFilters :
        kind === 'sound' ? soundFilters :
        [{ name: 'Все файлы', extensions: ['*'] }];
      const r = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'], filters });
      return r.canceled ? [] : r.filePaths;
    },

    showInFolder: (p: string) => {
      shell.showItemInFolder(p);
    },

    registerHotkeys: (map: Record<string, string>) => registerHotkeys(map, (buttonId) => {
      // Хоткей нажат глобально — уведомляем сервер через зарегистрированный колбэк
      setImmediate(() => bridgeCallbacks.onHotkey(buttonId));
    }),

    clearHotkeys: () => clearHotkeys(),

    setCallbacks: (cb) => {
      bridgeCallbacks = cb;
      deps.stage.onClosed(() => cb.onStageWindowClosed());
    }
  };

  return bridge;
}

export { moveWindowToDisplay };
