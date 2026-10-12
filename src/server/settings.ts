import { Settings } from '../shared/types';
import { AppPaths } from './paths';
import { JsonStore } from './store';
import { randomPin, randomToken } from './util';

export const DEFAULT_PORT = 8765;

export function defaultSettings(): Settings {
  return {
    port: DEFAULT_PORT,
    lanEnabled: false,
    lanPin: randomPin(),
    lanToken: randomToken(),
    musicFolders: [],
    videoFolders: [],
    stageDisplayId: null,
    defaults: {
      volume: 1,
      muted: false,
      fadeIn: 0,
      fadeOut: 0,
      afterAction: 'stop',
      stopBehavior: 'black'
    },
    crossfade: { enabled: false, duration: 2 },
    splash: { enabled: true, text: 'Sonic Studio', imagePath: '' },
    player: { volume: 0.9, muted: false, shuffle: false, repeat: 'off' }
  };
}

export function createSettingsStore(paths: AppPaths): JsonStore<Settings> {
  return new JsonStore<Settings>(paths.settings + '/settings.json', defaultSettings(), 300);
}
