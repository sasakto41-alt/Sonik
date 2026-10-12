import {
  PlayerState, StageState, EqState, ScanStatus, Snapshot, SystemInfo,
  DisplayInfo, LibraryRevisions, EQ_BANDS
} from '../shared/types';
import { JsonStore } from './store';

export class AppState {
  player: PlayerState = {
    trackId: null, title: '', artist: '', status: 'stopped', position: 0, duration: 0,
    volume: 0.9, muted: false, shuffle: false, repeat: 'off', queue: [], queueIndex: -1,
    updatedAt: Date.now()
  };

  stage: StageState = {
    status: 'idle', videoId: null, videoTitle: '', position: 0, duration: 0,
    volume: 1, muted: false, repeat: false, playlist: [], playlistIndex: -1,
    displayId: null, pendingDisplayId: null, fullscreen: false, blacked: false,
    splash: true, activeFade: null, fadeIn: 0, fadeOut: 0, windowOpen: false,
    nextVideoTitle: '', error: null, updatedAt: Date.now()
  };

  eq: EqState = {
    enabled: false, preset: 'Flat', gains: [...EQ_BANDS.map(() => 0)], customPresets: []
  };

  scan: ScanStatus = { active: false, kind: null, processed: 0, total: 0, current: '', errors: [] };
  displays: DisplayInfo[] = [];
  revisions: LibraryRevisions = { music: 1, videos: 1, playlists: 1, videoPlaylists: 1, soundboard: 1, settings: 1, history: 1 };
  private version = 1;

  constructor(eqStore: JsonStore<EqState>) {
    this.eq = eqStore.data;
    if (!Array.isArray(this.eq.gains) || this.eq.gains.length !== EQ_BANDS.length) {
      this.eq.gains = EQ_BANDS.map(() => 0);
    }
  }

  touchEqSave(eqStore: JsonStore<EqState>): void {
    eqStore.scheduleSave();
  }

  touch(kind: keyof LibraryRevisions): void {
    this.revisions[kind]++;
  }

  bumpVersion(): number {
    return ++this.version;
  }

  snapshot(system: SystemInfo): Snapshot {
    return {
      version: this.version,
      player: { ...this.player, updatedAt: Date.now() },
      stage: { ...this.stage, updatedAt: Date.now() },
      eq: { ...this.eq, gains: [...this.eq.gains], customPresets: this.eq.customPresets.map(p => ({ ...p, gains: [...p.gains] })) },
      displays: this.displays.map(d => ({ ...d })),
      scan: { ...this.scan, errors: [...this.scan.errors] },
      system,
      revisions: { ...this.revisions }
    };
  }
}
