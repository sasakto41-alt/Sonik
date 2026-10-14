import { Track, Snapshot } from '../shared/types';
import { el, h, clear, makeSlider, fmtTime, toast } from './ui';
import { ICONS, icon } from './icons';
import { player } from './player';
import { store } from './store';
import { api, mediaUrl, isElectron } from './api';

/**
 * Панель музыкального плеера (внизу окна) и панель очереди.
 */

export function initPlayerBar(): void {
  const root = el<HTMLElement>('#playerbar');
  clear(root);

  const cover = h('div', { class: 'pb-cover' });
  const meta = h('div', { class: 'pb-meta' },
    h('div', { class: 'pb-title', id: 'pb-title' }, 'Ничего не играет'),
    h('div', { class: 'pb-artist', id: 'pb-artist' }, '—'));
  const favBtn = h('button', { class: 'icon-btn', html: ICONS.heart, title: 'Избранное' }) as HTMLButtonElement;

  const shuffleBtn = h('button', { class: 'icon-btn', html: ICONS.shuffle, title: 'Перемешивание' }) as HTMLButtonElement;
  const prevBtn = h('button', { class: 'icon-btn', html: ICONS.prev, title: 'Предыдущий (Ctrl+←)' }) as HTMLButtonElement;
  const playBtn = h('button', { class: 'pb-play', html: ICONS.play, title: 'Play/Pause (Space)' }) as HTMLButtonElement;
  const nextBtn = h('button', { class: 'icon-btn', html: ICONS.next, title: 'Следующий (Ctrl+→)' }) as HTMLButtonElement;
  const repeatBtn = h('button', { class: 'icon-btn', html: ICONS.repeat, title: 'Повтор' }) as HTMLButtonElement;

  const timeCur = h('span', { class: 'pb-time' }, '0:00');
  const timeEnd = h('span', { class: 'pb-time' }, '0:00');
  const progress = makeSlider({
    value: 0, max: 1,
    onInput: (v) => { timeCur.textContent = fmtTime(v); },
    onChange: (v) => {
      if (isElectron()) player.seek(v);
      else void player.remoteCommand('seek', { time: v });
    }
  });

  const muteBtn = h('button', { class: 'icon-btn', html: ICONS.volume, title: 'Звук' }) as HTMLButtonElement;
  const volume = makeSlider({
    value: 0.9, max: 1,
    onInput: (v) => {
      if (isElectron()) player.setVolume(v);
      else void player.remoteCommand('setVolume', { volume: v });
    }
  });
  const queueBtn = h('button', { class: 'icon-btn', html: ICONS.queue, title: 'Очередь' }) as HTMLButtonElement;

  root.append(
    h('div', { class: 'pb-left' }, cover, meta, favBtn),
    h('div', { class: 'pb-center' },
      h('div', { class: 'pb-buttons' }, shuffleBtn, prevBtn, playBtn, nextBtn, repeatBtn),
      h('div', { class: 'pb-progress' }, timeCur, progress.root, timeEnd)),
    h('div', { class: 'pb-right' }, muteBtn, volume.root, queueBtn)
  );

  // ─── Обработчики ───

  const doCmd = (action: string, payload: Record<string, unknown> = {}) => {
    if (isElectron()) void player.command(action, payload);
    else void player.remoteCommand(action, payload);
  };

  playBtn.addEventListener('click', () => doCmd('toggle'));
  prevBtn.addEventListener('click', () => doCmd('prev'));
  nextBtn.addEventListener('click', () => doCmd('next'));
  shuffleBtn.addEventListener('click', () => doCmd('toggleShuffle'));
  repeatBtn.addEventListener('click', () => doCmd('cycleRepeat'));
  muteBtn.addEventListener('click', () => doCmd('setMuted', { muted: !player.state.muted }));
  queueBtn.addEventListener('click', () => toggleQueue());
  favBtn.addEventListener('click', async () => {
    const id = player.state.trackId;
    if (!id || !currentFavTrack) return;
    const nv = !currentFavTrack.favorite;
    try {
      await api.post('/api/music/favorite', { id, favorite: nv });
      currentFavTrack.favorite = nv;
      updateFav();
      toast('success', nv ? 'Добавлено в избранное' : 'Убрано из избранного');
      document.dispatchEvent(new CustomEvent('sonic:library-changed'));
    } catch { /* тост из api */ }
  });

  let currentFavTrack: Track | null = null;
  function updateFav(): void {
    if (!currentFavTrack) { favBtn.innerHTML = ICONS.heart; favBtn.classList.remove('active'); return; }
    favBtn.innerHTML = currentFavTrack.favorite ? ICONS.heartFill : ICONS.heart;
    favBtn.classList.toggle('active', currentFavTrack.favorite);
  }

  function applyState(): void {
    const st = player.state;
    el<HTMLElement>('#pb-title').textContent = st.title || 'Ничего не играет';
    el<HTMLElement>('#pb-artist').textContent = st.artist || (st.status === 'stopped' ? '—' : '');
    playBtn.innerHTML = st.status === 'playing' ? ICONS.pause : ICONS.play;
    shuffleBtn.classList.toggle('active', st.shuffle);
    repeatBtn.classList.toggle('active', st.repeat !== 'off');
    repeatBtn.innerHTML = st.repeat === 'one' ? ICONS.repeatOne : ICONS.repeat;
    muteBtn.innerHTML = st.muted ? ICONS.volumeMute : ICONS.volume;
    volume.setValue(st.muted ? 0 : st.volume, true);
    timeEnd.textContent = fmtTime(st.duration);
    progress.root.classList.toggle('disabled', !st.trackId);
    // Обложка
    if (st.trackId) {
      cover.style.backgroundImage = `url("${mediaUrl(`/api/music/cover/${st.trackId}`)}")`;
      cover.classList.add('has');
    } else {
      cover.style.backgroundImage = '';
      cover.classList.remove('has');
    }
    // Позиция — если пользователь не тянет ползунок
    const dragging = progress.root.classList.contains('dragging');
    if (!dragging) {
      const pos = isElectron() ? st.position : store.estimatePosition('player');
      progress.setValue(pos, true);
      timeCur.textContent = fmtTime(pos);
    }
    updateFav();
  }

  player.on('state', applyState);
  player.on('track', (t) => { currentFavTrack = t; updateFav(); });
  applyState();

  // Интерполяция позиции на веб-клиентах
  if (!isElectron()) {
    window.setInterval(() => {
      if (player.state.status === 'playing') {
        const pos = store.estimatePosition('player');
        progress.setValue(pos, true);
        timeCur.textContent = fmtTime(pos);
      }
    }, 500);
  }

  // Растягиваем max прогресса по длительности
  window.setInterval(() => {
    progress.setMax(Math.max(1, player.state.duration));
    if (isElectron() && player.state.status === 'playing') {
      const pos = player.state.position;
      progress.setValue(pos, true);
      timeCur.textContent = fmtTime(pos);
    }
  }, 500);
}

/** Панель очереди воспроизведения. */
export function toggleQueue(force?: boolean): void {
  const drawer = el<HTMLElement>('#queue-drawer');
  const show = force !== undefined ? force : drawer.classList.contains('hidden');
  if (!show) {
    drawer.classList.add('hidden');
    return;
  }
  drawer.classList.remove('hidden');
  renderQueue();
}

function renderQueue(): void {
  const drawer = el<HTMLElement>('#queue-drawer');
  clear(drawer);
  const st = player.state;
  drawer.append(h('div', { class: 'queue-head' },
    h('div', { class: 'queue-title' }, 'Очередь воспроизведения'),
    h('button', { class: 'btn ghost small', onclick: async () => {
      if (isElectron()) player.clearQueue();
      else await player.remoteCommand('clearQueue');
      renderQueue();
    } }, 'Очистить'),
    h('button', { class: 'icon-btn', html: ICONS.close, onclick: () => toggleQueue(false), title: 'Закрыть' })));

  if (st.queue.length === 0) {
    drawer.append(h('div', { class: 'queue-empty' }, 'Очередь пуста. Добавьте треки из раздела «Музыка».'));
    return;
  }
  const list = h('div', { class: 'queue-list' });
  st.queue.forEach((id, i) => {
    const active = i === st.queueIndex;
    list.append(h('div', { class: 'queue-item' + (active ? ' active' : '') },
      h('button', { class: 'queue-name', onclick: async () => {
        if (isElectron()) await player.jumpTo(i);
        else await player.remoteCommand('setQueueIndex', { index: i });
        renderQueue();
      } }, `${i + 1}. ${active ? '▶ ' : ''}трек ${id.slice(0, 8)}…`),
      h('button', { class: 'icon-btn small', html: ICONS.close, title: 'Убрать из очереди', onclick: async () => {
        if (isElectron()) player.removeQueueItem(i);
        else await player.remoteCommand('removeQueueItem', { index: i });
        renderQueue();
      } })));
  });
  drawer.append(list);
  // Названия треков подтягиваем из библиотеки
  void api.get<{ tracks: Track[] }>('/api/music/tracks').then(r => {
    const byId = new Map(r.tracks.map(t => [t.id, t]));
    list.querySelectorAll('.queue-name').forEach((elm, i) => {
      const t = byId.get(st.queue[i]);
      if (t) elm.textContent = `${i + 1}. ${t.title} — ${t.artist}`;
    });
  }).catch(() => {});
}

/** Индикатор состояния в шапке: маленькая точка (зелёная — ок, жёлтая — сбой). */
export function updateConnStatus(connected: boolean, _isDesktop: boolean): void {
  const root = el<HTMLElement>('#conn-status');
  root.classList.toggle('ok', connected);
  root.classList.toggle('bad', !connected);
  root.title = connected ? '' : 'Внутренний сбой — восстановление автоматически';
}

export function coverImg(track: Track): HTMLElement {
  const box = h('div', { class: 'track-cover' });
  if (track.coverFile) {
    const img = h('img', { src: mediaUrl(`/api/music/cover/${track.id}`), alt: '', loading: 'lazy' }) as HTMLImageElement;
    img.addEventListener('error', () => { box.classList.add('empty'); img.remove(); });
    box.append(img);
  } else {
    box.classList.add('empty');
    box.innerHTML = icon('music');
  }
  return box;
}

export function snapshotListener(fn: (s: Snapshot) => void): () => void {
  const off = store.on(e => { if (e.type === 'snapshot') fn(e.snapshot); });
  if (store.snapshot) fn(store.snapshot);
  return off;
}
