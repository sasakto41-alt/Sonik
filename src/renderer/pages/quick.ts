import { h, clear, toast, confirmDialog, modal, spinner } from '../ui';
import { ICONS, icon } from '../icons';
import { api, mediaUrl } from '../api';
import { QuickConfig, QuickTile, QuickTileSize, Track, Playlist, SoundButton, SoundboardConfig } from '../../shared/types';
import { navigate } from '../main';
import { player } from '../player';

/**
 * Блок «Быстрый доступ» на главном экране (дашборд).
 * Отдельного раздела больше нет: плитки живут прямо на «Главной»,
 * поэтому всё управление — с одного экрана, без переходов по меню.
 * - добавляйте действия плеера, треки, плейлисты, звуки Soundboard и разделы;
 * - перетаскивайте плитки мышью (режим правки), меняйте размер S → M → L;
 * - конфигурация сохраняется на сервере и переживает перезапуск;
 * - название трека, плей/пауза и громкость — в панели плеера внизу окна.
 */

export interface LibData {
  tracks: Map<string, Track>;
  playlists: Map<string, Playlist>;
  sounds: Map<string, SoundButton>;
}

const ACTION_META: Record<string, { label: string; icon: string; hint: string }> = {
  playPause: { label: 'Плей / Пауза', icon: 'play', hint: 'Запустить или приостановить музыку' },
  next: { label: 'Следующий трек', icon: 'next', hint: 'Ctrl+→' },
  prev: { label: 'Предыдущий трек', icon: 'prev', hint: 'Ctrl+←' },
  stop: { label: 'Стоп', icon: 'stop', hint: 'Остановить воспроизведение' },
  volume: { label: 'Громкость', icon: 'volume', hint: 'Ползунок громкости' },
  repeat: { label: 'Повтор', icon: 'repeat', hint: 'Выкл → Всё → Один трек' },
  shuffle: { label: 'Перемешивание', icon: 'shuffle', hint: 'Случайный порядок очереди' },
  stopAllSounds: { label: 'Стоп все звуки', icon: 'sound', hint: 'Остановить Soundboard' }
};

const SECTION_META: Record<string, { label: string; icon: string }> = {
  home: { label: 'Главная', icon: 'home' },
  music: { label: 'Музыка', icon: 'music' },
  playlists: { label: 'Плейлисты', icon: 'playlist' },
  videos: { label: 'Видео', icon: 'video' },
  soundboard: { label: 'Soundboard', icon: 'soundboard' },
  editor: { label: 'Аудиоредактор', icon: 'editor' },
  equalizer: { label: 'Эквалайзер', icon: 'equalizer' },
  visualizer: { label: 'Визуализация', icon: 'visualizer' },
  stage: { label: 'Сценический вывод', icon: 'stage' },
  settings: { label: 'Настройки', icon: 'settings' },
  stageBlack: { label: 'Чёрный экран', icon: 'black' },
  stageRestore: { label: 'Вернуть картинку', icon: 'play' },
  stageStop: { label: 'Остановить сцену', icon: 'stop' }
};

const SIZE_ORDER: QuickTileSize[] = ['s', 'm', 'l'];
const SIZE_LABEL: Record<QuickTileSize, string> = { s: 'S', m: 'M', l: 'L' };

/** Конфигурация плиток + библиотека (треки/плейлисты/звуки) одним запросом набора. */
export async function loadQuickData(): Promise<{ config: QuickConfig } & LibData> {
  const [t, p, s, q] = await Promise.all([
    api.get<{ tracks: Track[] }>('/api/music/tracks'),
    api.get<{ playlists: Playlist[] }>('/api/playlists'),
    api.get<{ config: SoundboardConfig }>('/api/soundboard'),
    api.get<{ config: QuickConfig }>('/api/quick')
  ]);
  return {
    config: q.config,
    tracks: new Map(t.tracks.map(x => [x.id, x])),
    playlists: new Map(p.playlists.map(x => [x.id, x])),
    sounds: new Map(s.config.buttons.map(x => [x.id, x]))
  };
}

export interface QuickSection {
  root: HTMLElement;
  teardown: () => void;
}

/**
 * Создаёт блок плиток для главного экрана.
 * config мутируется при правке (размер/порядок/состав) и сохраняется на сервере.
 */
export function createQuickSection(config: QuickConfig, lib: LibData): QuickSection {
  const root = h('section', { class: 'quick-section' });
  let cfg: QuickConfig = config;
  let editMode = false;
  let dragId: string | null = null;
  let disposed = false;

  // Живое обновление плиток Плей/Пауза, Повтор, Перемешивание
  const offState = player.on('state', () => {
    if (disposed) return;
    root.querySelectorAll<HTMLElement>('[data-action="playPause"] .qtile-icon').forEach(elm => {
      elm.innerHTML = player.state.status === 'playing' ? ICONS.pause : ICONS.play;
    });
    root.querySelectorAll<HTMLElement>('[data-action="repeat"]').forEach(elm => {
      elm.classList.toggle('active', player.state.repeat !== 'off');
    });
    root.querySelectorAll<HTMLElement>('[data-action="shuffle"]').forEach(elm => {
      elm.classList.toggle('active', player.state.shuffle);
    });
  });

  async function persist(): Promise<void> {
    try {
      const r = await api.put<{ config: QuickConfig }>('/api/quick', { enabled: cfg.enabled, tiles: cfg.tiles });
      cfg = r.config;
    } catch { /* тост из api */ }
  }

  function tileLabel(t: QuickTile): string {
    if (t.label) return t.label;
    if (t.kind === 'action' && t.action) return ACTION_META[t.action].label;
    if (t.kind === 'section' && t.section) return SECTION_META[t.section]?.label || t.section;
    if (t.kind === 'track' && t.refId) return lib.tracks.get(t.refId)?.title || 'Трек';
    if (t.kind === 'playlist' && t.refId) return lib.playlists.get(t.refId)?.name || 'Плейлист';
    if (t.kind === 'sound' && t.refId) return lib.sounds.get(t.refId)?.name || 'Звук';
    return 'Плитка';
  }

  function tileIcon(t: QuickTile): string {
    if (t.kind === 'action' && t.action) {
      if (t.action === 'playPause') return player.state.status === 'playing' ? ICONS.pause : ICONS.play;
      return icon(ACTION_META[t.action].icon);
    }
    if (t.kind === 'section' && t.section) return icon(SECTION_META[t.section]?.icon || 'info');
    if (t.kind === 'track') return icon('music');
    if (t.kind === 'playlist') return icon('playlist');
    if (t.kind === 'sound') return icon(lib.sounds.get(t.refId || '')?.icon || 'sound');
    return icon('info');
  }

  // ─── Выполнение плитки ───

  async function execute(t: QuickTile): Promise<void> {
    if (t.kind === 'action' && t.action) {
      const a = t.action;
      if (a === 'playPause') void player.toggle();
      else if (a === 'next') void player.next();
      else if (a === 'prev') void player.prev();
      else if (a === 'stop') void player.command('stop');
      else if (a === 'repeat') void player.command('cycleRepeat');
      else if (a === 'shuffle') void player.command('toggleShuffle');
      else if (a === 'stopAllSounds') {
        await api.post('/api/soundboard/stop-all', {});
        toast('success', 'Все звуки остановлены');
      }
      // volume — обрабатывается собственным слайдером плитки
      return;
    }
    if (t.kind === 'section' && t.section) {
      const s = t.section;
      if (s === 'stageBlack' || s === 'stageRestore' || s === 'stageStop') {
        const action = s === 'stageBlack' ? 'black' : s === 'stageRestore' ? 'restore' : 'stop';
        try {
          const r = await api.post<{ ok: boolean }>('/api/stage/command', { action });
          if (r.ok) toast('success', SECTION_META[s].label + ': выполнено');
        } catch { /* тост из api (например, 409 подтверждение экрана) */ }
      } else {
        navigate(s);
      }
      return;
    }
    if (t.kind === 'track' && t.refId) {
      const track = lib.tracks.get(t.refId);
      if (!track) { toast('error', 'Трек не найден в библиотеке'); return; }
      if (track.missing) { toast('error', 'Файл трека отсутствует на диске'); return; }
      await player.playTrack(t.refId, [t.refId]);
      return;
    }
    if (t.kind === 'playlist' && t.refId) {
      const pl = lib.playlists.get(t.refId);
      if (!pl) { toast('error', 'Плейлист не найден'); return; }
      const ids = pl.trackIds.filter(id => { const tr = lib.tracks.get(id); return tr && !tr.missing; });
      if (ids.length === 0) { toast('error', 'Плейлист пуст или файлы недоступны'); return; }
      await player.playTrack(ids[0], ids);
      toast('info', `Играет плейлист «${pl.name}» — ${ids.length} трек(ов)`);
      return;
    }
    if (t.kind === 'sound' && t.refId) {
      try {
        await api.post('/api/soundboard/trigger', { buttonId: t.refId });
      } catch { /* тост из api */ }
    }
  }

  // ─── Рендер плитки ───

  function tileEl(t: QuickTile): HTMLElement {
    const cls = `qtile qtile-${t.size}` + (editMode ? ' editing' : '');
    const box = h('div', { class: cls, 'data-tile-id': t.id, draggable: editMode ? 'true' : undefined });
    if (t.kind === 'action') box.dataset.action = t.action || '';
    if (t.kind === 'section') box.dataset.section = t.section || '';

    // Звук — фирменный цвет кнопки
    if (t.kind === 'sound') {
      const b = lib.sounds.get(t.refId || '');
      if (b?.color) box.style.setProperty('--tile-color', b.color);
    }

    const iconWrap = h('span', { class: 'qtile-icon' }, '');
    if (t.kind === 'track' && lib.tracks.get(t.refId || '')?.coverFile) {
      iconWrap.classList.add('has-img');
      iconWrap.innerHTML = `<img src="${mediaUrl(`/api/music/cover/${t.refId}`)}" alt="" loading="lazy">`;
    } else {
      iconWrap.innerHTML = tileIcon(t);
    }

    box.append(iconWrap, h('span', { class: 'qtile-label', title: tileLabel(t) }, tileLabel(t)));

    if (t.kind === 'action' && t.action === 'volume') {
      const val = h('span', { class: 'qtile-value' }, Math.round(player.state.volume * 100) + '%');
      const slider = h('input', { type: 'range', min: '0', max: '1', step: '0.01', value: String(player.state.volume) }) as HTMLInputElement;
      slider.addEventListener('input', () => {
        const v = Number(slider.value);
        player.setVolume(v);
        val.textContent = Math.round(v * 100) + '%';
      });
      box.append(h('div', { class: 'qtile-volume' }, slider, val));
    }

    if (editMode) {
      // Кнопка размера: S → M → L → S
      box.append(h('button', {
        class: 'qtile-size', title: 'Размер плитки',
        onclick: (e) => {
          e.stopPropagation();
          const i = SIZE_ORDER.indexOf(t.size);
          t.size = SIZE_ORDER[(i + 1) % SIZE_ORDER.length];
          void persist();
          renderGrid();
        }
      }, SIZE_LABEL[t.size]));
      box.append(h('button', {
        class: 'qtile-remove', title: 'Убрать плитку', html: ICONS.close,
        onclick: async (e) => {
          e.stopPropagation();
          const ok = await confirmDialog('Убрать плитку', `Убрать «${tileLabel(t)}» из быстрого доступа?`, 'Убрать');
          if (!ok) return;
          cfg.tiles = cfg.tiles.filter(x => x.id !== t.id);
          await persist();
          renderGrid();
        }
      }));
    } else {
      box.addEventListener('click', () => void execute(t));
    }

    // Drag & drop (только в режиме правки)
    box.addEventListener('dragstart', () => {
      dragId = t.id;
      box.classList.add('dragging');
    });
    box.addEventListener('dragend', () => {
      dragId = null;
      box.classList.remove('dragging');
    });
    box.addEventListener('dragover', (e) => {
      if (!editMode || !dragId || dragId === t.id) return;
      e.preventDefault();
      box.classList.add('drag-over');
    });
    box.addEventListener('dragleave', () => box.classList.remove('drag-over'));
    box.addEventListener('drop', (e) => {
      e.preventDefault();
      box.classList.remove('drag-over');
      if (!editMode || !dragId || dragId === t.id) return;
      const from = cfg.tiles.findIndex(x => x.id === dragId);
      const to = cfg.tiles.findIndex(x => x.id === t.id);
      if (from < 0 || to < 0) return;
      const [moved] = cfg.tiles.splice(from, 1);
      cfg.tiles.splice(to, 0, moved);
      dragId = null;
      void persist();
      renderGrid();
    });

    return box;
  }

  // ─── Сетка и шапка блока ───

  const grid = h('div', { class: 'quick-grid' });

  function renderGrid(): void {
    clear(grid);
    for (const t of cfg.tiles) grid.append(tileEl(t));
    if (cfg.tiles.length === 0) {
      grid.append(h('div', { class: 'quick-empty-note' },
        'Сетка пуста. Нажмите «Добавить», чтобы разместить действия, треки, плейлисты, звуки и разделы.'));
    }
  }

  function renderShell(): void {
    clear(root);
    const head = h('div', { class: 'page-head' },
      h('h2', { class: 'page-title' }, 'Быстрый доступ'),
      h('div', { class: 'btn-row' },
        h('button', {
          class: 'btn accent',
          html: icon('plus') + '<span>Добавить</span>',
          onclick: () => openAddPanel()
        }),
        h('button', {
          class: 'btn' + (editMode ? ' ghost' : ''),
          html: icon(editMode ? 'check' : 'edit') + `<span>${editMode ? 'Готово' : 'Редактировать'}</span>`,
          onclick: () => { editMode = !editMode; renderShell(); }
        })));
    const hint = h('div', { class: 'muted note' },
      editMode
        ? 'Режим правки: перетаскивайте плитки мышью, кнопка S/M/L меняет размер, крестик убирает плитку.'
        : 'Нажмите плитку, чтобы выполнить действие. Управление плеером — в панели внизу окна.');
    root.append(head, hint, grid);
    renderGrid();
  }

  // ─── Панель добавления ───

  function openAddPanel(): void {
    modal('Добавить плитку', (body, close) => {
      const tabs = h('div', { class: 'btn-row wrap qadd-tabs' });
      const list = h('div', { class: 'qadd-list' });
      body.append(tabs, list);

      const TABS: Array<{ id: string; label: string }> = [
        { id: 'actions', label: 'Действия' },
        { id: 'tracks', label: 'Треки' },
        { id: 'playlists', label: 'Плейлисты' },
        { id: 'sounds', label: 'Звуки' },
        { id: 'sections', label: 'Разделы' }
      ];
      let activeTab = 'actions';

      const add = async (tile: Omit<QuickTile, 'id'>, name: string) => {
        if (cfg.tiles.length >= 64) { toast('error', 'Достигнут предел — 64 плитки'); return; }
        cfg.tiles.push({ ...tile, id: 'q-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) });
        await persist();
        renderGrid();
        toast('success', `Добавлено: ${name}`);
      };

      function tabActions(): void {
        clear(list);
        for (const [key, meta] of Object.entries(ACTION_META)) {
          list.append(h('button', { class: 'qadd-item', onclick: () => void add({ kind: 'action', size: 's', action: key as never }, meta.label) },
            h('span', { class: 'qadd-icon', html: icon(meta.icon) }),
            h('span', { class: 'qadd-name' }, meta.label),
            h('span', { class: 'qadd-hint' }, meta.hint)));
        }
      }

      function tabTracks(): void {
        clear(list);
        const search = h('input', { class: 'input', type: 'search', placeholder: 'Поиск трека…' }) as HTMLInputElement;
        const listBox = h('div', { class: 'qadd-scroll' });
        list.append(search, listBox);
        const fill = (q: string): void => {
          clear(listBox);
          const query = q.trim().toLowerCase();
          const items = [...lib.tracks.values()].filter(t =>
            !query || t.title.toLowerCase().includes(query) || t.artist.toLowerCase().includes(query));
          if (items.length === 0) { listBox.append(h('div', { class: 'muted' }, 'Ничего не найдено')); return; }
          for (const t of items.slice(0, 60)) {
            listBox.append(h('button', { class: 'qadd-item', onclick: () => void add({ kind: 'track', size: 's', refId: t.id, label: t.title }, t.title) },
              h('span', { class: 'qadd-icon' + (t.coverFile ? ' has-img' : ''),
                html: t.coverFile ? `<img src="${mediaUrl(`/api/music/cover/${t.id}`)}" alt="">` : icon('music') }),
              h('span', { class: 'qadd-name' }, t.title),
              h('span', { class: 'qadd-hint' }, t.artist)));
          }
        };
        search.addEventListener('input', () => fill(search.value));
        fill('');
      }

      function tabPlaylists(): void {
        clear(list);
        const listBox = h('div', { class: 'qadd-scroll' });
        list.append(listBox);
        const items = [...lib.playlists.values()];
        if (items.length === 0) { listBox.append(h('div', { class: 'muted' }, 'Плейлистов пока нет — создайте их в разделе «Плейлисты»')); return; }
        for (const p of items) {
          listBox.append(h('button', { class: 'qadd-item', onclick: () => void add({ kind: 'playlist', size: 'm', refId: p.id, label: p.name }, p.name) },
            h('span', { class: 'qadd-icon', html: icon('playlist') }),
            h('span', { class: 'qadd-name' }, p.name),
            h('span', { class: 'qadd-hint' }, `${p.trackIds.length} трек(ов) — запускает весь плейлист`)));
        }
      }

      function tabSounds(): void {
        clear(list);
        const listBox = h('div', { class: 'qadd-scroll' });
        list.append(listBox);
        const items = [...lib.sounds.values()];
        if (items.length === 0) { listBox.append(h('div', { class: 'muted' }, 'Звуков пока нет — добавьте их в разделе «Soundboard»')); return; }
        for (const b of items) {
          const btn = h('button', { class: 'qadd-item', onclick: () => void add({ kind: 'sound', size: 's', refId: b.id, label: b.name }, b.name) },
            h('span', { class: 'qadd-icon', html: icon(b.icon || 'sound'), style: `color:${b.color || 'var(--accent-bright)'}` }),
            h('span', { class: 'qadd-name' }, b.name),
            h('span', { class: 'qadd-hint' }, 'Запускает звук Soundboard')) as HTMLButtonElement;
          btn.style.setProperty('--tile-color', b.color || '');
          listBox.append(btn);
        }
      }

      function tabSections(): void {
        clear(list);
        const listBox = h('div', { class: 'qadd-scroll' });
        list.append(listBox);
        for (const [key, meta] of Object.entries(SECTION_META)) {
          const isStageCmd = key === 'stageBlack' || key === 'stageRestore' || key === 'stageStop';
          listBox.append(h('button', { class: 'qadd-item', onclick: () => void add({ kind: 'section', size: 's', section: key as never }, meta.label) },
            h('span', { class: 'qadd-icon', html: icon(meta.icon) }),
            h('span', { class: 'qadd-name' }, meta.label),
            h('span', { class: 'qadd-hint' }, isStageCmd ? 'Команда сценического вывода' : 'Открывает раздел приложения')));
        }
      }

      function showTab(id: string): void {
        activeTab = id;
        clear(tabs);
        for (const t of TABS) {
          tabs.append(h('button', {
            class: 'btn small' + (t.id === activeTab ? ' accent' : ' ghost'),
            onclick: () => showTab(t.id)
          }, t.label));
        }
        if (activeTab === 'actions') tabActions();
        else if (activeTab === 'tracks') tabTracks();
        else if (activeTab === 'playlists') tabPlaylists();
        else if (activeTab === 'sounds') tabSounds();
        else tabSections();
      }

      showTab(activeTab);
      void close;
    }, { wide: true });
  }

  renderShell();

  return {
    root,
    teardown: () => {
      disposed = true;
      offState();
    }
  };
}

/** Заглушка на время загрузки блока плиток. */
export function quickSectionSkeleton(): HTMLElement {
  return h('section', { class: 'quick-section' }, spinner());
}
