import { h, clear, emptyState, spinner, toast, confirmDialog, promptDialog } from '../ui';
import { ICONS, icon } from '../icons';
import { api, mediaUrl } from '../api';
import { Track, Playlist } from '../../shared/types';
import { player } from '../player';
import { isElectron } from '../api';

/**
 * Плейлисты: сетка карточек, создание/переименование/удаление,
 * просмотр состава, воспроизведение, переупорядочивание.
 */
export function mountPlaylists(container: HTMLElement): void {
  clear(container);
  const wrap = h('div', { class: 'page-wrap' });
  container.append(wrap);
  let openId: string | null = null;

  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  openId = params.get('open');

  render();

  async function render(): Promise<void> {
    clear(wrap);
    wrap.append(spinner());
    try {
      const [plsResp, tracksResp] = await Promise.all([
        api.get<{ playlists: Playlist[] }>('/api/playlists'),
        api.get<{ tracks: Track[] }>('/api/music/tracks')
      ]);
      const byId = new Map(tracksResp.tracks.map(t => [t.id, t]));
      clear(wrap);

      const head = h('div', { class: 'page-head' },
        h('h2', { class: 'page-title' }, 'Плейлисты'),
        h('button', { class: 'btn accent', html: icon('plus') + '<span>Создать</span>', onclick: () => void createPlaylist() }));
      wrap.append(head);

      if (openId) {
        const pl = plsResp.playlists.find(p => p.id === openId);
        if (pl) {
          wrap.append(renderDetail(pl, byId));
          return;
        }
        openId = null;
      }

      if (plsResp.playlists.length === 0) {
        wrap.append(emptyState(ICONS.playlist, 'Плейлистов пока нет',
          'Создайте первый плейлист и добавьте в него треки.',
          { label: 'Создать плейлист', onClick: () => void createPlaylist() }));
        return;
      }

      const grid = h('div', { class: 'playlist-grid' });
      for (const pl of plsResp.playlists) grid.append(playlistCard(pl, byId));
      wrap.append(grid);
    } catch {
      clear(wrap);
    }
  }

  function coverFor(pl: Playlist, byId: Map<string, Track>): HTMLElement {
    const box = h('div', { class: 'pl-cover' });
    const tracks = pl.trackIds.map(id => byId.get(id)).filter(Boolean).slice(0, 4) as Track[];
    if (tracks.length === 0) {
      box.classList.add('empty');
      box.innerHTML = icon('playlist');
    } else {
      for (const t of tracks) {
        const q = h('div', { class: 'pl-cover-cell' });
        if (t.coverFile) q.append(h('img', { src: mediaUrl(`/api/music/cover/${t.id}`), alt: '' }));
        box.append(q);
      }
    }
    return box;
  }

  function playlistCard(pl: Playlist, byId: Map<string, Track>): HTMLElement {
    return h('div', { class: 'card pl-card' },
      h('button', { class: 'pl-cover-wrap', onclick: () => { openId = pl.id; history.replaceState(null, '', `#/playlists?open=${pl.id}`); render(); } },
        coverFor(pl, byId),
        h('span', { class: 'cover-play', html: ICONS.play })),
      h('div', { class: 'card-body' },
        h('div', { class: 'card-name' }, pl.name),
        h('div', { class: 'card-sub' }, `${pl.trackIds.length} трек(ов)`)),
      h('div', { class: 'card-actions' },
        h('button', { class: 'icon-btn small', html: ICONS.play, title: 'Воспроизвести', onclick: () => void playPlaylist(pl) }),
        h('button', { class: 'icon-btn small', html: ICONS.edit, title: 'Переименовать', onclick: () => void renamePlaylist(pl) }),
        h('button', { class: 'icon-btn small danger', html: ICONS.trash, title: 'Удалить', onclick: () => void deletePlaylist(pl) })));
  }

  function renderDetail(pl: Playlist, byId: Map<string, Track>): HTMLElement {
    const box = h('div', { class: 'pl-detail' });
    box.append(h('div', { class: 'page-head' },
      h('button', { class: 'btn ghost', onclick: () => { openId = null; history.replaceState(null, '', '#/playlists'); render(); } }, '← Все плейлисты'),
      h('h2', { class: 'page-title' }, pl.name),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn accent', html: ICONS.play + '<span>Играть</span>', onclick: () => void playPlaylist(pl) }),
        h('button', { class: 'btn', html: ICONS.edit + '<span>Переименовать</span>', onclick: () => void renamePlaylist(pl) }),
        h('button', { class: 'btn ghost danger', html: ICONS.trash + '<span>Удалить</span>', onclick: () => void deletePlaylist(pl) }))));

    if (pl.trackIds.length === 0) {
      box.append(emptyState(ICONS.music, 'Плейлист пуст', 'Добавьте треки из раздела «Музыка» кнопкой «В плейлист».'));
      return box;
    }

    const list = h('div', { class: 'track-list' });
    pl.trackIds.forEach((id, i) => {
      const t = byId.get(id);
      if (!t) return;
      const row = h('div', { class: 'track-row', draggable: 'true' },
        h('span', { class: 'row-index' }, String(i + 1)),
        h('button', { class: 'row-play', html: ICONS.play, onclick: () => {
          const ids = pl.trackIds.filter(x => byId.has(x));
          if (isElectron()) void player.playTrack(t.id, ids);
          else void player.remoteCommand('playTrack', { trackId: t.id, queue: ids });
        } }),
        h('div', { class: 'row-main' },
          h('div', { class: 'row-title' }, t.title),
          h('div', { class: 'row-sub' }, t.artist)),
        h('span', { class: 'row-time' }, Math.floor(t.duration / 60) + ':' + String(Math.floor(t.duration % 60)).padStart(2, '0')),
        h('button', { class: 'icon-btn small', title: 'Вверх', onclick: () => void reorder(pl, i, -1) }, '↑'),
        h('button', { class: 'icon-btn small', title: 'Вниз', onclick: () => void reorder(pl, i, 1) }, '↓'),
        h('button', { class: 'icon-btn small danger', html: ICONS.close, title: 'Убрать', onclick: () => void removeFromPlaylist(pl, i) }));
      // Drag&drop переупорядочивание
      row.addEventListener('dragstart', (e) => {
        (e as DragEvent).dataTransfer?.setData('text/plain', String(i));
        row.classList.add('dragging');
      });
      row.addEventListener('dragend', () => row.classList.remove('dragging'));
      row.addEventListener('dragover', (e) => e.preventDefault());
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        const from = Number((e as DragEvent).dataTransfer?.getData('text/plain'));
        if (!isFinite(from) || from === i) return;
        const ids = [...pl.trackIds];
        const [moved] = ids.splice(from, 1);
        ids.splice(i, 0, moved);
        void api.put(`/api/playlists/${pl.id}`, { trackIds: ids }).then(() => render());
      });
      list.append(row);
    });
    box.append(list);
    return box;
  }

  async function createPlaylist(): Promise<void> {
    const name = await promptDialog('Новый плейлист', 'Название плейлиста');
    if (!name) return;
    await api.post('/api/playlists', { name });
    toast('success', 'Плейлист создан');
    render();
  }

  async function renamePlaylist(pl: Playlist): Promise<void> {
    const name = await promptDialog('Переименовать', 'Новое название', pl.name);
    if (!name) return;
    await api.put(`/api/playlists/${pl.id}`, { name });
    render();
  }

  async function deletePlaylist(pl: Playlist): Promise<void> {
    const ok = await confirmDialog('Удалить плейлист', `Удалить плейлист «${pl.name}»?`, 'Удалить', true);
    if (!ok) return;
    await api.del(`/api/playlists/${pl.id}`);
    if (openId === pl.id) openId = null;
    toast('success', 'Плейлист удалён');
    render();
  }

  async function playPlaylist(pl: Playlist): Promise<void> {
    const tracksResp = await api.get<{ tracks: Track[] }>('/api/music/tracks');
    const ids = pl.trackIds.filter(id => tracksResp.tracks.some(t => t.id === id));
    if (ids.length === 0) { toast('info', 'Плейлист пуст или треки отсутствуют'); return; }
    if (isElectron()) await player.playTrack(ids[0], ids);
    else await player.remoteCommand('playTrack', { trackId: ids[0], queue: ids });
  }

  async function reorder(pl: Playlist, index: number, dir: -1 | 1): Promise<void> {
    const to = index + dir;
    if (to < 0 || to >= pl.trackIds.length) return;
    const ids = [...pl.trackIds];
    const [moved] = ids.splice(index, 1);
    ids.splice(to, 0, moved);
    await api.put(`/api/playlists/${pl.id}`, { trackIds: ids });
    render();
  }

  async function removeFromPlaylist(pl: Playlist, index: number): Promise<void> {
    const ids = [...pl.trackIds];
    ids.splice(index, 1);
    await api.put(`/api/playlists/${pl.id}`, { trackIds: ids });
    render();
  }
}
