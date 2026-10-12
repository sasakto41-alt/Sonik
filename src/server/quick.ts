import { QuickConfig, QuickTile, QuickTileKind, QuickTileSize, QuickPlayerAction, QuickSectionTarget } from '../shared/types';
import { AppPaths } from './paths';
import { JsonStore } from './store';
import { uuid } from './util';

/**
 * Быстрый режим: пользовательская сетка плиток (действия плеера, треки,
 * плейлисты, звуки Soundboard, разделы приложения и команды сцены).
 * Конфигурация хранится в settings/quick.json и переживает обновления.
 */

const TILE_KINDS: QuickTileKind[] = ['action', 'track', 'playlist', 'sound', 'section'];
const TILE_SIZES: QuickTileSize[] = ['s', 'm', 'l'];
const ACTIONS: QuickPlayerAction[] = ['playPause', 'next', 'prev', 'stop', 'volume', 'repeat', 'shuffle', 'stopAllSounds'];
const SECTIONS: QuickSectionTarget[] = [
  'home', 'music', 'playlists', 'videos', 'soundboard', 'editor',
  'equalizer', 'visualizer', 'stage', 'settings',
  'stageBlack', 'stageRestore', 'stageStop'
];

export function defaultQuickConfig(): QuickConfig {
  return {
    enabled: false,
    // Стартовый набор при первом включении: пользователю есть что посмотреть,
    // дальше он может переставить, удалить или добавить своё.
    tiles: [
      { id: 'q-playpause', kind: 'action', size: 'm', action: 'playPause' },
      { id: 'q-next', kind: 'action', size: 's', action: 'next' },
      { id: 'q-prev', kind: 'action', size: 's', action: 'prev' },
      { id: 'q-volume', kind: 'action', size: 'm', action: 'volume' },
      { id: 'q-stage', kind: 'section', size: 's', section: 'stage' },
      { id: 'q-black', kind: 'section', size: 's', section: 'stageBlack' },
      { id: 'q-music', kind: 'section', size: 's', section: 'music' },
      { id: 'q-viz', kind: 'section', size: 's', section: 'visualizer' }
    ]
  };
}

export class QuickManager {
  readonly store: JsonStore<QuickConfig>;

  constructor(paths: AppPaths) {
    this.store = new JsonStore<QuickConfig>(paths.settings + '/quick.json', defaultQuickConfig(), 250);
  }

  get config(): QuickConfig {
    return this.store.data;
  }

  get enabled(): boolean {
    return this.store.data.enabled === true;
  }

  /** Включение/выключение (используется из настроек и со страницы режима). */
  setEnabled(on: boolean): QuickConfig {
    this.store.updateNow(d => { d.enabled = on; });
    return this.config;
  }

  /** Полная замена списка плиток (порядок = порядок в массиве). */
  replaceTiles(tiles: QuickTile[]): QuickConfig {
    this.store.updateNow(d => { d.tiles = this.sanitizeTiles(tiles); });
    return this.config;
  }

  /** Валидация конфигурации из внешних источников (API, резервная копия). */
  sanitizeConfig(body: Record<string, unknown>): QuickConfig {
    const d = this.store.data;
    if (typeof body.enabled === 'boolean') d.enabled = body.enabled;
    if (Array.isArray(body.tiles)) d.tiles = this.sanitizeTiles(body.tiles as unknown[]);
    this.store.updateNow(() => { /* запись уже выполнена мутацией выше */ });
    return this.config;
  }

  sanitizeTiles(raw: unknown[]): QuickTile[] {
    const out: QuickTile[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const t = item as Record<string, unknown>;
      const kind = String(t.kind) as QuickTileKind;
      if (!TILE_KINDS.includes(kind)) continue;
      const size = (TILE_SIZES.includes(String(t.size) as QuickTileSize) ? String(t.size) : 's') as QuickTileSize;
      const tile: QuickTile = {
        id: typeof t.id === 'string' && t.id ? t.id.slice(0, 64) : uuid(),
        kind,
        size
      };
      if (typeof t.label === 'string' && t.label.trim()) tile.label = t.label.trim().slice(0, 80);
      if (kind === 'action' && ACTIONS.includes(String(t.action) as QuickPlayerAction)) {
        tile.action = String(t.action) as QuickPlayerAction;
      } else if (kind === 'section' && SECTIONS.includes(String(t.section) as QuickSectionTarget)) {
        tile.section = String(t.section) as QuickSectionTarget;
      } else if ((kind === 'track' || kind === 'playlist' || kind === 'sound') && typeof t.refId === 'string' && t.refId) {
        tile.refId = t.refId.slice(0, 64);
      } else {
        continue; // плитка без корректной ссылки не имеет смысла
      }
      out.push(tile);
      if (out.length >= 64) break; // разумный предел сетки
    }
    return out;
  }

  saveNow(): void {
    try { this.store.saveNow(); } catch { /* журнал не падаем */ }
  }
}
