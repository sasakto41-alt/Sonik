import { h, clear, fmtTime, emptyState, spinner } from '../ui';
import { ICONS, icon } from '../icons';
import { api, mediaUrl, isElectron } from '../api';
import { Track, VideoItem, HistoryEntry, Playlist } from '../../shared/types';
import { navigate } from '../main';
import { snapshotListener } from '../components';
import { store } from '../store';
import { player } from '../player';

/**
 * Главный экран.
 * - в приложении (компьютер): быстрый доступ в стиле LivePlay — слева акты
 *   (плейлисты), справа цветные карточки-купюры с треками; номер на карточке =
 *   клавиша 1–9, нажал — трек сразу играет. Название трека, плей/пауза и
 *   громкость — в панели плеера внизу окна.
 * - в браузере: приветствие и недавний контент (приложение полностью локальное).
 */

export function mountHome(container: HTMLElement): { teardown?: () => void } | void {
  if (isElectron()) return mountDesktopHome(container);

  clear(container);
  container.append(spinner());

  const off = snapshotListener(async (s) => {
    off();
    clear(container);

    const hour = new Date().getHours();
    const greeting = hour < 5 ? 'Доброй ночи' : hour < 12 ? 'Доброе утро' : hour < 18 ? 'Добрый день' : 'Добрый вечер';

    const hero = h('div', { class: 'home-hero' },
      h('div', { class: 'home-greeting' }, greeting + '!'),
      h('div', { class: 'home-sub' },
        'Управляйте воспроизведением на компьютере. Приложение работает полностью локально.'));

    const quick = h('div', { class: 'quick-actions' });
    const actions: Array<{ label: string; icon: string; onClick: () => void }> = [
      { label: 'Сценический вывод', icon: 'stage', onClick: () => navigate('stage') },
      { label: 'Soundboard', icon: 'soundboard', onClick: () => navigate('soundboard') },
      { label: 'Визуализация', icon: 'visualizer', onClick: () => navigate('visualizer') }
    ];
    for (const a of actions) {
      quick.append(h('button', { class: 'quick-card', onclick: a.onClick },
        h('span', { class: 'quick-icon', html: icon(a.icon) }),
        h('span', { class: 'quick-label' }, a.label)));
    }

    container.append(hero, quick);

    // Недавно прослушанные треки
    try {
      const hist = await api.get<{ items: HistoryEntry[] }>('/api/music/history');
      const tracksResp = await api.get<{ tracks: Track[] }>('/api/music/tracks');
      const byId = new Map(tracksResp.tracks.map(t => [t.id, t]));
      const recent = hist.items.slice(0, 6).map(x => byId.get(x.id)).filter((t): t is Track => Boolean(t));
      if (recent.length > 0) {
        container.append(sectionTitle('Недавно прослушано', 'music'));
        const row = h('div', { class: 'card-grid' });
        for (const t of recent) row.append(trackCard(t));
        container.append(row);
      }
      // Избранное
      const fav = tracksResp.tracks.filter(t => t.favorite).slice(0, 6);
      if (fav.length > 0) {
        container.append(sectionTitle('Избранное', 'music'));
        const row = h('div', { class: 'card-grid' });
        for (const t of fav) row.append(trackCard(t));
        container.append(row);
      }
      // Пустая библиотека
      if (tracksResp.tracks.length === 0) {
        container.append(emptyState(ICONS.music, 'Библиотека музыки пуста',
          'Импортируйте файлы или папки в приложении на компьютере.',
          { label: 'Перейти к музыке', onClick: () => navigate('music') }));
      }
    } catch { /* сбои тихие — точка в шапке покажет состояние */ }
  });

  return { teardown: () => off() };
}

// ─── Быстрый доступ в стиле LivePlay ─────────────────────────────────────────

/** Палитра цветов актов — как разноцветные карточки Cart Player в LivePlay. */
const ACT_COLORS = [
  '#a78bfa', '#ffa552', '#ffd54f', '#9ccc65', '#4dd0e1',
  '#f06292', '#64b5f6', '#aed581', '#ff8a65', '#9575cd',
  '#4fc3f7', '#e57373', '#ba68c8', '#ffb74d', '#81c784'
];

function actColor(index: number): string {
  return ACT_COLORS[index % ACT_COLORS.length];
}

interface DashData {
  playlists: Playlist[];
  tracks: Track[];
}

/** Главный экран в приложении: акты + карточки-купюры + плеер внизу. */
function mountDesktopHome(container: HTMLElement): { teardown: () => void } {
  clear(container);
  container.append(spinner());

  let data: DashData | null = null;
  let selectedAct = sessionStorage.getItem('sonic.act') || '';
  let disposed = false;
  let lastMusicRev = -1;
  let lastPlRev = -1;
  const cardEls = new Map<string, HTMLElement>();

  const off = snapshotListener((s) => {
    // Первичный снимок рисует экран, дальше — только живое обновление подсветки
    if (!data) void reload(true);
    else {
      if (s.revisions.music !== lastMusicRev || s.revisions.playlists !== lastPlRev) void reload(false);
      syncPlaying(s.player.trackId, s.player.status);
    }
  });

  async function reload(initial: boolean): Promise<void> {
    try {
      const [pl, tr] = await Promise.all([
        api.get<{ playlists: Playlist[] }>('/api/playlists'),
        api.get<{ tracks: Track[] }>('/api/music/tracks')
      ]);
      if (disposed) return;
      data = { playlists: pl.playlists, tracks: tr.tracks };
      lastMusicRev = store.snapshot?.revisions.music ?? -1;
      lastPlRev = store.snapshot?.revisions.playlists ?? -1;
      if (initial) render();
      else { renderActs(); renderCues(); syncPlayingCurrent(); }
    } catch { /* точка в шапке покажет сбой; WS переподключится */ }
  }

  function render(): void {
    if (disposed || !data) return;
    clear(container);

    const head = h('div', { class: 'page-head' },
      h('h2', { class: 'page-title' }, 'Быстрый доступ'),
      h('div', { class: 'page-sub' },
        'Карточка = трек. Цифра на карточке — клавиша: нажали на клавиатуре — трек играет. Плеер внизу окна.'));

    const dash = h('div', { class: 'dash' });
    const actsPanel = h('div', { class: 'card acts-panel' });
    const cuesArea = h('div', { class: 'cues-area' });
    dash.append(actsPanel, cuesArea);
    container.append(head, dash);

    renderActs();
    renderCues();
    syncPlayingCurrent();

    // Горячие клавиши 1–9 — запуск карточек выбранного акта
    window.addEventListener('keydown', onHotkey);
  }

  function currentAct(): Playlist | null {
    if (!data) return null;
    if (data.playlists.length === 0) return null;
    const found = data.playlists.find(p => p.id === selectedAct);
    return found || data.playlists[0];
  }

  function actTracks(act: Playlist | null): Track[] {
    if (!act || !data) return [];
    const byId = new Map(data.tracks.map(t => [t.id, t]));
    return act.trackIds.map(id => byId.get(id)).filter((t): t is Track => Boolean(t));
  }

  function renderActs(): void {
    if (!data) return;
    const panel = container.querySelector('.acts-panel') as HTMLElement | null;
    if (!panel) return;
    clear(panel);
    panel.append(h('div', { class: 'card-title' }, 'Акты (плейлисты)'));

    if (data.playlists.length === 0) {
      panel.append(h('div', { class: 'muted', style: 'padding:8px 2px;line-height:1.5' },
        'Плейлистов пока нет. Создайте плейлист — он станет «актом» здесь.'));
      return;
    }

    const list = h('div', { class: 'acts-list' });
    data.playlists.forEach((p, i) => {
      const act = currentAct();
      const active = (act ? act.id : '') === p.id;
      const count = p.trackIds.length;
      const item = h('button', {
        class: 'act-item' + (active ? ' active' : ''),
        style: `--c:${actColor(i)}`,
        onclick: () => {
          selectedAct = p.id;
          sessionStorage.setItem('sonic.act', p.id);
          renderActs();
          renderCues();
          syncPlayingCurrent();
        }
      },
        h('span', { class: 'act-swatch' }),
        h('span', { class: 'act-meta' },
          h('span', { class: 'act-name', title: p.name }, p.name),
          h('span', { class: 'act-sub' }, totalDuration(p.trackIds))),
        h('span', { class: 'act-count' }, String(count)));
      list.append(item);
    });
    panel.append(list);
  }

  function totalDuration(ids: string[]): string {
    if (!data) return '';
    const byId = new Map(data.tracks.map(t => [t.id, t]));
    let sum = 0;
    for (const id of ids) { const t = byId.get(id); if (t) sum += t.duration; }
    return `${fmtTime(sum)} · ${ids.length} трек${ids.length % 10 === 1 && ids.length !== 11 ? '' : (ids.length % 10 >= 2 && ids.length % 10 <= 4 && (ids.length < 12 || ids.length > 14) ? 'а' : 'ов')}`;
  }

  function renderCues(): void {
    if (!data) return;
    const area = container.querySelector('.cues-area') as HTMLElement | null;
    if (!area) return;
    clear(area);
    cardEls.clear();

    const act = currentAct();

    if (!act) {
      area.append(h('div', { class: 'dash-empty' },
        h('div', { class: 'card-title' }, 'Здесь будут карточки треков'),
        h('div', { class: 'muted' },
          'Создайте плейлист в разделе «Плейлисты», добавьте в него треки — и плейлист появится слева как «акт», а его треки — цветными карточками, как в LivePlay.'),
        h('button', { class: 'btn accent', onclick: () => navigate('playlists') }, 'Открыть плейлисты')));
      return;
    }

    const tracks = actTracks(act);
    const head = h('div', { class: 'cues-head' },
      h('div', { class: 'cues-title' }, act.name),
      h('div', { class: 'cues-sub' }, tracks.length ? `${tracks.length} карточек — играются по клику или клавишам 1–9` : ''));

    const grid = h('div', { class: 'cue-grid' });

    if (tracks.length === 0) {
      area.append(head, h('div', { class: 'dash-empty' },
        h('div', {}, 'В этом акте пока нет треков.'),
        h('button', { class: 'btn', onclick: () => navigate('playlists') }, 'Добавить треки в плейлист')));
      return;
    }

    tracks.forEach((t, i) => {
      const color = actColor(data!.playlists.findIndex(p => p.id === act.id));
      const key = i < 9 ? String(i + 1) : '';
      const num = h('span', { class: 'cue-num' }, String(i + 1));
      const playBtn = h('button', {
        class: 'cue-play', title: 'Играть', html: ICONS.play,
        onclick: (e: Event) => { e.stopPropagation(); void play(t); }
      }) as HTMLButtonElement;
      const card = h('button', {
        class: 'cue-card',
        style: `--c:${color}`,
        'data-track-id': t.id,
        title: `${t.title} — ${t.artist}`,
        onclick: () => void play(t)
      },
        h('span', { class: 'cue-top' }, num,
          key ? h('span', { class: 'cue-key' }, key) : null,
          playBtn),
        h('span', { class: 'cue-title' }, t.title + (t.missing ? ' (файл отсутствует)' : '')),
        h('span', { class: 'cue-sub' }, `${t.artist} · ${fmtTime(t.duration)}`)) as HTMLElement;
      cardEls.set(t.id, card);
      grid.append(card);
    });

    area.append(head, grid);
  }

  async function play(t: Track): Promise<void> {
    const act = currentAct();
    const queue = act ? actTracks(act).map(x => x.id) : [t.id];
    await player.playTrack(t.id, queue);
  }

  /** Живая подсветка играющей карточки по снимку состояния. */
  function syncPlaying(trackId: string | null, status: string): void {
    for (const [id, el] of cardEls) {
      el.classList.toggle('playing', id === trackId && status === 'playing');
      el.classList.toggle('paused', id === trackId && status === 'paused');
    }
  }

  function syncPlayingCurrent(): void {
    if (store.snapshot) syncPlaying(store.snapshot.player.trackId, store.snapshot.player.status);
  }

  function onHotkey(e: KeyboardEvent): void {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (!/^[1-9]$/.test(e.key)) return;
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
    const act = currentAct();
    if (!act) return;
    const tracks = actTracks(act);
    const idx = Number(e.key) - 1;
    const t = tracks[idx];
    if (t) { e.preventDefault(); void play(t); }
  }

  const onLibraryChanged = (): void => void reload(false);
  document.addEventListener('sonic:library-changed', onLibraryChanged);

  void reload(true);

  return {
    teardown: () => {
      disposed = true;
      off();
      window.removeEventListener('keydown', onHotkey);
      document.removeEventListener('sonic:library-changed', onLibraryChanged);
    }
  };
}

export function sectionTitle(title: string, ic = 'music'): HTMLElement {
  return h('div', { class: 'section-title' },
    h('span', { class: 'section-icon', html: icon(ic) }), title);
}

export function trackCard(t: Track): HTMLElement {
  return h('div', { class: 'card track-card' + (t.missing ? ' missing' : '') },
    h('button', { class: 'card-cover', onclick: () => playTrack(t) },
      t.coverFile
        ? h('img', { src: mediaUrl(`/api/music/cover/${t.id}`), alt: '', loading: 'lazy' })
        : h('span', { html: icon('music') }),
      h('span', { class: 'cover-play', html: ICONS.play })),
    h('div', { class: 'card-body' },
      h('div', { class: 'card-name', title: t.title }, t.title + (t.missing ? ' (файл отсутствует)' : '')),
      h('div', { class: 'card-sub' }, `${t.artist}${t.album ? ' · ' + t.album : ''} · ${fmtTime(t.duration)}`)));
}

export function videoCard(v: VideoItem): HTMLElement {
  const c = h('div', { class: 'card video-card' + (v.missing ? ' missing' : '') });
  c.append(h('button', { class: 'card-cover video', onclick: () => navigate('videos') },
    v.thumbFile
      ? h('img', { src: mediaUrl(`/api/videos/thumb/${v.id}`), alt: '', loading: 'lazy' })
      : h('span', { html: icon('video') }),
    h('span', { class: 'duration-badge' }, fmtTime(v.duration))));
  c.append(h('div', { class: 'card-body' },
    h('div', { class: 'card-name', title: v.title }, v.title + (v.missing ? ' (файл отсутствует)' : '')),
    h('div', { class: 'card-sub' }, v.format.toUpperCase())));
  return c;
}

export async function playTrack(t: Track): Promise<void> {
  if (isElectron()) await player.playTrack(t.id, [t.id]);
  else await player.remoteCommand('playTrack', { trackId: t.id, queue: [t.id] });
}
