import { h, clear, el, fmtTime, fmtDate, emptyState, spinner, toast, confirmDialog, makeSlider } from '../ui';
import { ICONS, icon } from '../icons';
import { api, mediaUrl, isElectron } from '../api';
import { Track, Playlist, HistoryEntry } from '../../shared/types';
import { snapshotListener, coverImg } from '../components';
import { player } from '../player';
import { navigate } from '../main';

/**
 * Музыка: вкладки «Треки | Избранное | История», поиск, сортировка,
 * импорт файлов/папок, сканирование, действия над треками.
 */
export function mountMusic(container: HTMLElement): { teardown: () => void } {
  clear(container);
  let tab = 'tracks';
  let search = '';
  let sort = 'added';
  let order: 'asc' | 'desc' = 'desc';
  let teardown = false;

  const toolbar = h('div', { class: 'toolbar' });
  const listWrap = h('div', { class: 'list-wrap' });
  container.append(toolbar, listWrap);

  function renderToolbar(): void {
    clear(toolbar);
    // Вкладки
    const tabs = h('div', { class: 'tabs' });
    for (const t of [['tracks', 'Треки'], ['fav', 'Избранное'], ['history', 'История']]) {
      tabs.append(h('button', { class: 'tab' + (tab === t[0] ? ' active' : ''), onclick: () => { tab = t[0]; render(); } }, t[1]));
    }
    toolbar.append(tabs);

    if (tab !== 'history') {
      const searchBox = h('div', { class: 'search-box' },
        h('span', { class: 'search-icon', html: ICONS.search }),
        h('input', { class: 'input', placeholder: 'Поиск: название, исполнитель, альбом', value: search,
          oninput: (e: Event) => { search = (e.target as HTMLInputElement).value; renderList(); } })) as HTMLDivElement;
      const sortSel = h('select', { class: 'input select', onchange: (e: Event) => { sort = (e.target as HTMLSelectElement).value; renderList(); } },
        ...[['added', 'По дате добавления'], ['title', 'По названию'], ['artist', 'По исполнителю'], ['album', 'По альбому'], ['duration', 'По длительности'], ['lastPlayed', 'По недавнему прослушиванию']]
          .map(([v, l]) => h('option', { value: v, selected: sort === v }, l))) as HTMLSelectElement;
      const orderBtn = h('button', { class: 'icon-btn', title: 'Порядок', onclick: () => { order = order === 'asc' ? 'desc' : 'asc'; renderList(); } },
        order === 'asc' ? '↑' : '↓') as HTMLButtonElement;
      toolbar.append(searchBox, sortSel, orderBtn);
    }

    if (isElectron() && tab !== 'history') {
      toolbar.append(
        h('button', { class: 'btn accent', html: icon('folderPlus') + '<span>Файлы</span>', onclick: () => void importFiles() }),
        h('button', { class: 'btn', html: icon('folder') + '<span>Папка</span>', onclick: () => void importFolder() }),
        h('button', { class: 'btn ghost', html: icon('refresh') + '<span>Пересканировать</span>', onclick: () => void rescan() }));
    } else if (tab !== 'history') {
      toolbar.append(h('button', { class: 'btn ghost', html: icon('refresh') + '<span>Пересканировать</span>', onclick: () => void rescan() }));
    }
  }

  async function importFiles(): Promise<void> {
    const files = await windowSonic().pickFiles('music');
    if (!files || files.length === 0) return;
    try {
      const r = await api.post<{ added: number; updated: number; errors: string[] }>('/api/music/files', { paths: files });
      toast('success', `Добавлено ${r.added}, обновлено ${r.updated}` + (r.errors.length ? `, ошибок: ${r.errors.length}` : ''));
      renderList();
    } catch { /* тост из api */ }
  }

  async function importFolder(): Promise<void> {
    const folder = await windowSonic().pickFolder();
    if (!folder) return;
    const s = await api.get<{ settings: { musicFolders: string[] } }>('/api/settings');
    await api.put('/api/settings', { musicFolders: [...s.settings.musicFolders, folder] });
    await rescan();
  }

  async function rescan(): Promise<void> {
    try {
      await api.post('/api/music/scan', {});
      toast('info', 'Сканирование запущено');
    } catch (e) {
      toast('error', (e as Error).message);
    }
  }

  function renderToolbarPlaceholder(): void {
    // заглушка для типизации windowSonic
  }
  void renderToolbarPlaceholder;

  async function renderList(): Promise<void> {
    clear(listWrap);
    listWrap.append(spinner());
    try {
      if (tab === 'history') {
        const r = await api.get<{ items: HistoryEntry[] }>('/api/music/history');
        clear(listWrap);
        if (r.items.length === 0) {
          listWrap.append(emptyState(ICONS.clock, 'История пуста', 'Здесь появятся прослушанные треки.'));
          return;
        }
        const list = h('div', { class: 'track-list' });
        r.items.forEach((item, i) => {
          list.append(h('div', { class: 'track-row history' },
            h('span', { class: 'row-index' }, String(i + 1)),
            h('div', { class: 'row-main' },
              h('div', { class: 'row-title' }, item.title),
              h('div', { class: 'row-sub' }, item.subtitle)),
            h('span', { class: 'row-time' }, fmtDate(item.at))));
        });
        listWrap.append(list);
        return;
      }
      const params = new URLSearchParams({ sort, order });
      if (search) params.set('search', search);
      if (tab === 'fav') params.set('favorite', '1');
      const r = await api.get<{ tracks: Track[]; total: number }>(`/api/music/tracks?${params}`);
      clear(listWrap);
      if (r.tracks.length === 0) {
        listWrap.append(emptyState(ICONS.music,
          search ? 'Ничего не найдено' : (tab === 'fav' ? 'В избранном пока пусто' : 'Библиотека пуста'),
          search ? 'Попробуйте изменить запрос.' : 'Добавьте музыку с компьютера — файлы остаются в своих папках.',
          !isElectron() && !search ? undefined : { label: 'Импортировать музыку', onClick: () => void importFolder() }));
        return;
      }
      const list = h('div', { class: 'track-list' });
      for (const t of r.tracks) list.append(trackRow(t));
      listWrap.append(list);
      // Индикатор сканирования
      const s = store.snapshot;
      if (s?.scan.active && s.scan.kind === 'music') {
        listWrap.append(h('div', { class: 'scan-status' },
          h('span', { class: 'spinner small' }),
          `Сканирование: ${s.scan.processed}/${s.scan.total} — ${s.scan.current}`));
      }
    } catch {
      clear(listWrap);
    }
  }

  function trackRow(t: Track): HTMLElement {
    const isCurrent = player.state.trackId === t.id;
    const row = h('div', { class: 'track-row' + (isCurrent ? ' current' : '') + (t.missing ? ' missing' : '') });
    row.append(
      h('button', { class: 'row-play', html: isCurrent && player.state.status === 'playing' ? ICONS.pause : ICONS.play,
        title: 'Воспроизвести',
        onclick: () => void togglePlay(t) }),
      coverImg(t),
      h('div', { class: 'row-main' },
        h('div', { class: 'row-title' }, t.title + (t.missing ? ' — файл отсутствует' : '')),
        h('div', { class: 'row-sub' }, `${t.artist}${t.album ? ' · ' + t.album : ''}`)),
      h('span', { class: 'row-format' }, t.format.toUpperCase()),
      h('span', { class: 'row-time' }, fmtTime(t.duration)),
      h('button', { class: 'icon-btn small' + (t.favorite ? ' active' : ''),
        html: t.favorite ? ICONS.heartFill : ICONS.heart,
        title: 'Избранное',
        onclick: () => void toggleFav(t) }),
      h('button', { class: 'icon-btn small', html: ICONS.queue, title: 'В очередь',
        onclick: () => void addToQueue(t, false) }),
      h('button', { class: 'icon-btn small', html: ICONS.send, title: 'Играть следующим',
        onclick: () => void addToQueue(t, true) }),
      h('button', { class: 'icon-btn small', html: ICONS.playlist, title: 'В плейлист',
        onclick: () => void addToPlaylist(t) }),
      h('button', { class: 'icon-btn small danger', html: ICONS.trash, title: 'Удалить из библиотеки',
        onclick: () => void removeTrack(t) }));
    row.addEventListener('dblclick', () => void togglePlay(t));
    return row;
  }

  async function togglePlay(t: Track): Promise<void> {
    if (player.state.trackId === t.id && player.state.status === 'playing') {
      if (isElectron()) player.pause(); else await player.remoteCommand('pause');
    } else {
      if (isElectron()) await player.playTrack(t.id, player.state.queue.length ? player.state.queue : [t.id]);
      else await player.remoteCommand('playTrack', { trackId: t.id, queue: player.state.queue.length ? player.state.queue : [t.id] });
    }
  }

  async function toggleFav(t: Track): Promise<void> {
    await api.post('/api/music/favorite', { id: t.id, favorite: !t.favorite });
    t.favorite = !t.favorite;
    renderList();
  }

  async function addToQueue(t: Track, next: boolean): Promise<void> {
    if (isElectron()) player.addToQueue(t.id, next);
    else await player.remoteCommand('addToQueue', { trackId: t.id, next });
    toast('success', next ? 'Будет проигран следующим' : 'Добавлено в очередь');
    renderList();
  }

  async function addToPlaylist(t: Track): Promise<void> {
    const pls = (await api.get<{ playlists: Playlist[] }>('/api/playlists')).playlists;
    const { modal } = await import('../ui');
    modal('Добавить в плейлист', (body, close) => {
      const row = h('div', { class: 'btn-col' });
      const createBtn = h('button', { class: 'btn ghost' }, '+ Создать новый плейлист');
      createBtn.addEventListener('click', async () => {
        const { promptDialog } = await import('../ui');
        const name = await promptDialog('Новый плейлист', 'Название плейлиста');
        if (!name) return;
        const pl = (await api.post<{ playlist: Playlist }>('/api/playlists', { name })).playlist;
        await api.post(`/api/playlists/${pl.id}/tracks`, { trackIds: [t.id], mode: 'append' });
        toast('success', `Добавлено в «${name}»`);
        close();
      });
      row.append(createBtn);
      for (const pl of pls) {
        row.append(h('button', { class: 'btn ghost', onclick: async () => {
          await api.post(`/api/playlists/${pl.id}/tracks`, { trackIds: [t.id], mode: 'append' });
          toast('success', `Добавлено в «${pl.name}»`);
          close();
        } }, `${pl.name} (${pl.trackIds.length})`));
      }
      body.append(row);
    });
  }

  async function removeTrack(t: Track): Promise<void> {
    const { confirmDialog } = await import('../ui');
    const ok = await confirmDialog('Удалить трек', `Удалить «${t.title}» из библиотеки? Сам файл на диске не будет удалён.`, 'Удалить', true);
    if (!ok) return;
    await api.del(`/api/music/tracks/${t.id}`);
    renderList();
  }

  function render(): void {
    renderToolbar();
    void renderList();
  }

  render();

  // Реакция на снапшоты: обновляем индикатор сканирования и текущий трек
  const offSnap = snapshotListener((s) => {
    if (s.scan.active && s.scan.kind === 'music') {
      const statusEl = listWrap.querySelector('.scan-status');
      if (statusEl) {
        statusEl.textContent = `Сканирование: ${s.scan.processed}/${s.scan.total} — ${s.scan.current}`;
      }
    } else if (listWrap.querySelector('.scan-status')) {
      void renderList();
    }
    document.querySelectorAll('.track-row').forEach(row => {
      row.classList.toggle('current', Boolean(s.player.trackId && row.querySelector('.row-title')?.textContent?.startsWith('')));
    });
  });
  // Перерисовка при смене статуса плеера
  const offState = player.state ? undefined : undefined;

  return {
    teardown: () => {
      teardown = true;
      offSnap();
      void offState; void teardown;
    }
  };
}

function windowSonic(): { pickFolder(): Promise<string | null>; pickFiles(kind: string): Promise<string[]> } {
  const w = window as unknown as { sonicDesktop?: { pickFolder(): Promise<string | null>; pickFiles(kind: 'music'): Promise<string[]> } };
  if (!w.sonicDesktop) {
    return {
      pickFolder: async () => null,
      pickFiles: async () => []
    };
  }
  return w.sonicDesktop;
}

// Импорт store для индикатора сканирования
import { store } from '../store';
