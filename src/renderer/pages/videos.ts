import { h, clear, el, fmtTime, fmtDate, emptyState, spinner, toast, confirmDialog, modal, promptDialog, makeSlider } from '../ui';
import { ICONS, icon } from '../icons';
import { api, mediaUrl, isElectron } from '../api';
import { VideoItem, VideoPlaylist, RISKY_VIDEO_EXTS } from '../../shared/types';
import { snapshotListener } from '../components';
import { store } from '../store';

/**
 * Видео: локальный предпросмотр-плеер (полный набор управлений),
 * карточки библиотеки с миниатюрами, «Вывести на экран», настройки ролика,
 * плейлисты видео и история просмотра.
 */
export function mountVideos(container: HTMLElement): { teardown: () => void } {
  clear(container);
  let tab = 'videos';
  let search = '';
  let sort = 'added';
  let order: 'asc' | 'desc' = 'desc';

  const toolbar = h('div', { class: 'toolbar' });
  const previewWrap = h('div', { class: 'video-preview' });
  const listWrap = h('div', { class: 'list-wrap' });
  container.append(toolbar, previewWrap, listWrap);

  // ─── Предпросмотр-плеер ───

  const video = h('video', { playsinline: true, preload: 'metadata' }) as HTMLVideoElement;
  const vpPlay = h('button', { class: 'pb-play', html: ICONS.play }) as HTMLButtonElement;
  const vpStop = h('button', { class: 'icon-btn', html: ICONS.stop, title: 'Стоп' }) as HTMLButtonElement;
  const vpPrev = h('button', { class: 'icon-btn', html: ICONS.prev, title: 'Предыдущий ролик' }) as HTMLButtonElement;
  const vpNext = h('button', { class: 'icon-btn', html: ICONS.next, title: 'Следующий ролик' }) as HTMLButtonElement;
  const vpMute = h('button', { class: 'icon-btn', html: ICONS.volume }) as HTMLButtonElement;
  const vpFull = h('button', { class: 'icon-btn', html: ICONS.fullscreen, title: 'Полный экран' }) as HTMLButtonElement;
  const vpRepeat = h('button', { class: 'icon-btn', html: ICONS.repeat, title: 'Повтор ролика' }) as HTMLButtonElement;
  const vpTime = h('span', { class: 'pb-time' }, '0:00');
  const vpDur = h('span', { class: 'pb-time' }, '0:00');
  const vpProgress = makeSlider({ value: 0, max: 1, onChange: (v: number) => { if (currentPreview) { video.currentTime = v; saveProgress(); } } });
  const vpVolume = makeSlider({ value: 1, max: 1, onInput: (v: number) => { video.volume = v; video.muted = false; } });
  const vpTitle = h('div', { class: 'vp-title' }, 'Локальный предпросмотр');
  const vpToStage = h('button', { class: 'btn accent small', html: icon('stage') + '<span>Вывести на экран</span>' }) as HTMLButtonElement;
  const vpResume = h('button', { class: 'btn ghost small hidden' }, 'Продолжить с сохранённой позиции') as HTMLButtonElement;
  let currentPreview: VideoItem | null = null;

  previewWrap.append(
    h('div', { class: 'vp-stage' },
      video,
      h('div', { class: 'vp-overlay' }, vpTitle, vpResume)),
    h('div', { class: 'vp-controls' },
      h('div', { class: 'vp-buttons' }, vpPrev, vpPlay, vpStop, vpNext, vpMute, vpVolume.root, vpRepeat, vpFull, vpToStage),
      h('div', { class: 'pb-progress' }, vpTime, vpProgress.root, vpDur)));

  video.addEventListener('loadedmetadata', () => {
    vpDur.textContent = fmtTime(video.duration);
    if (currentPreview && !currentPreview.duration) {
      void api.put(`/api/videos/${currentPreview.id}/settings`, {}) // фиксируем существование
        .catch(() => {});
      void api.post(`/api/videos/${currentPreview.id}/progress`, { position: currentPreview.lastPosition || 0 });
      // Обновляем длительность в библиотеке
      void api.put(`/api/videos/${currentPreview.id}/settings`, { });
      currentPreview.duration = video.duration;
      void api.put(`/api/videos/${currentPreview.id}/settings`, {} as never);
    }
  });
  video.addEventListener('timeupdate', () => {
    if (!vpProgress.root.classList.contains('dragging')) {
      vpProgress.setValue(video.currentTime, true);
      vpTime.textContent = fmtTime(video.currentTime);
    }
    if (video.paused) vpPlay.innerHTML = ICONS.play; else vpPlay.innerHTML = ICONS.pause;
  });
  video.addEventListener('ended', () => {
    vpPlay.innerHTML = ICONS.play;
    if (currentPreview?.repeat) {
      video.currentTime = currentPreview.startPosition || 0;
      void video.play();
    }
  });
  vpPlay.addEventListener('click', () => {
    if (!currentPreview) { toast('info', 'Выберите видео из библиотеки'); return; }
    if (video.paused) void video.play(); else video.pause();
  });
  vpStop.addEventListener('click', () => { video.pause(); video.currentTime = currentPreview?.startPosition || 0; });
  vpPrev.addEventListener('click', () => { void loadNeighbor(-1); });
  vpNext.addEventListener('click', () => { void loadNeighbor(1); });
  vpMute.addEventListener('click', () => {
    video.muted = !video.muted;
    vpMute.innerHTML = video.muted ? ICONS.volumeMute : ICONS.volume;
  });
  vpFull.addEventListener('click', () => {
    const stage = previewWrap.querySelector('.vp-stage') as HTMLElement;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void stage.requestFullscreen().catch(() => toast('error', 'Не удалось включить полноэкранный режим'));
  });
  vpRepeat.addEventListener('click', () => {
    if (!currentPreview) return;
    currentPreview.repeat = !currentPreview.repeat;
    void api.put(`/api/videos/${currentPreview.id}/settings`, { repeat: currentPreview.repeat });
    vpRepeat.classList.toggle('active', currentPreview.repeat);
  });
  vpFull.classList.add('active');
  vpToStage.addEventListener('click', async () => {
    if (!currentPreview) { toast('info', 'Сначала выберите видео'); return; }
    await sendToStage(currentPreview);
  });
  vpResume.addEventListener('click', () => {
    if (currentPreview?.lastPosition) video.currentTime = currentPreview.lastPosition;
    vpResume.classList.add('hidden');
    void video.play();
  });

  async function loadNeighbor(dir: -1 | 1): Promise<void> {
    const r = await api.get<{ videos: VideoItem[] }>(`/api/videos?sort=${sort}&order=${order}`);
    const videos = r.videos.filter(v => !v.missing);
    if (videos.length === 0) return;
    const idx = currentPreview ? videos.findIndex(v => v.id === currentPreview!.id) : -1;
    let next = idx + dir;
    if (next < 0) next = videos.length - 1;
    if (next >= videos.length) next = 0;
    await loadPreview(videos[next], true);
  }

  async function loadPreview(v: VideoItem, autoplay: boolean): Promise<void> {
    if (currentPreview && currentPreview.id !== v.id) await saveProgress();
    currentPreview = v;
    vpTitle.textContent = v.title + (RISKY_VIDEO_EXTS.includes('.' + v.format) ? ' · формат может не поддерживаться' : '');
    video.src = mediaUrl(`/api/media/video/${v.id}`);
    video.volume = v.volume;
    video.muted = v.muted;
    vpMute.innerHTML = v.muted ? ICONS.volumeMute : ICONS.volume;
    vpVolume.setValue(v.volume, true);
    vpRepeat.classList.toggle('active', v.repeat);
    vpResume.classList.toggle('hidden', !(v.lastPosition && v.lastPosition > 10));
    if (v.lastPosition && v.lastPosition > 10 && !vpResume.classList.contains('hidden')) {
      video.currentTime = 0;
    }
    if (autoplay) {
      try { await video.play(); } catch { /* автоплей может требовать жеста */ }
    }
    // История просмотра
    void api.post(`/api/videos/${v.id}/history`, {}).catch(() => {});
  }

  async function saveProgress(): Promise<void> {
    if (!currentPreview || video.currentTime < 1) return;
    await api.post(`/api/videos/${currentPreview.id}/progress`, { position: video.currentTime }).catch(() => {});
  }

  const progressTimer = window.setInterval(() => void saveProgress(), 5000);
  const maxTimer = window.setInterval(() => vpProgress.setMax(Math.max(1, video.duration || 1)), 1000);

  // ─── Тулбар ───

  function renderToolbar(): void {
    clear(toolbar);
    const tabs = h('div', { class: 'tabs' });
    for (const t of [['videos', 'Видео'], ['playlists', 'Плейлисты видео'], ['history', 'История']]) {
      tabs.append(h('button', { class: 'tab' + (tab === t[0] ? ' active' : ''), onclick: () => { tab = t[0]; void renderList(); } }, t[1]));
    }
    toolbar.append(tabs);
    if (tab === 'videos') {
      toolbar.append(
        h('div', { class: 'search-box' },
          h('span', { class: 'search-icon', html: ICONS.search }),
          h('input', { class: 'input', placeholder: 'Поиск видео', value: search, oninput: (e: Event) => { search = (e.target as HTMLInputElement).value; void renderList(); } })));
      if (isElectron()) {
        toolbar.append(
          h('button', { class: 'btn accent', html: icon('folderPlus') + '<span>Файлы</span>', onclick: () => void importFiles() }),
          h('button', { class: 'btn', html: icon('folder') + '<span>Папка</span>', onclick: () => void importFolder() }));
      }
      toolbar.append(
        h('button', { class: 'btn ghost', html: icon('refresh') + '<span>Пересканировать</span>', onclick: () => void rescan() }));
    } else if (tab === 'playlists') {
      toolbar.append(h('button', { class: 'btn accent', html: icon('plus') + '<span>Создать плейлист</span>', onclick: () => void createVideoPlaylist() }));
    }
  }

  async function importFiles(): Promise<void> {
    const files = await windowSonic().pickFiles('video');
    if (!files || files.length === 0) return;
    const r = await api.post<{ added: number; errors: string[] }>('/api/videos/files', { paths: files });
    toast('success', `Добавлено видео: ${r.added}` + (r.errors.length ? `, пропущено: ${r.errors.length}` : ''));
    void renderList();
  }

  async function importFolder(): Promise<void> {
    const folder = await windowSonic().pickFolder();
    if (!folder) return;
    const s = await api.get<{ settings: { videoFolders: string[] } }>('/api/settings');
    await api.put('/api/settings', { videoFolders: [...s.settings.videoFolders, folder] });
    await rescan();
  }

  async function rescan(): Promise<void> {
    try {
      await api.post('/api/videos/scan', {});
      toast('info', 'Сканирование видео запущено');
    } catch (e) { toast('error', (e as Error).message); }
  }

  // ─── Списки ───

  async function renderList(): Promise<void> {
    clear(listWrap);
    listWrap.append(spinner());
    renderToolbar();
    try {
      if (tab === 'playlists') {
        await renderVideoPlaylists();
        return;
      }
      if (tab === 'history') {
        const r = await api.get<{ items: { id: string; title: string; subtitle: string; at: number }[] }>('/api/videos/history');
        clear(listWrap);
        if (r.items.length === 0) { listWrap.append(emptyState(ICONS.clock, 'История пуста', 'Здесь появятся просмотренные видео.')); return; }
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
      const r = await api.get<{ videos: VideoItem[] }>(`/api/videos?${params}`);
      clear(listWrap);
      if (r.videos.length === 0) {
        listWrap.append(emptyState(ICONS.video, 'Видеотека пуста',
          'Импортируйте видеофайлы с компьютера. Поддерживаются MP4, WebM и другие форматы, которые декодирует система.',
          isElectron() ? { label: 'Импортировать видео', onClick: () => void importFolder() } : undefined));
        return;
      }
      const grid = h('div', { class: 'video-grid' });
      for (const v of r.videos) grid.append(videoCard(v));
      listWrap.append(grid);
      const s = store.snapshot;
      if (s?.scan.active && s.scan.kind === 'video') {
        listWrap.append(h('div', { class: 'scan-status' },
          h('span', { class: 'spinner small' }), `Сканирование: ${s.scan.processed}/${s.scan.total} — ${s.scan.current}`));
      }
    } catch {
      clear(listWrap);
    }
  }

  function videoCard(v: VideoItem): HTMLElement {
    const risky = RISKY_VIDEO_EXTS.includes('.' + v.format);
    const card = h('div', { class: 'card video-card' + (v.missing ? ' missing' : '') });
    card.append(
      h('button', { class: 'card-cover video', onclick: () => void loadPreview(v, true) },
        v.thumbFile
          ? h('img', { src: mediaUrl(`/api/videos/thumb/${v.id}`), alt: '', loading: 'lazy' })
          : h('span', { class: 'thumb-placeholder', html: icon('video') }),
        h('span', { class: 'duration-badge' }, fmtTime(v.duration)),
        h('span', { class: 'cover-play', html: ICONS.play })),
      h('div', { class: 'card-body' },
        h('div', { class: 'card-name', title: v.title }, v.title + (v.missing ? ' (файл отсутствует)' : '')),
        h('div', { class: 'card-sub' }, v.format.toUpperCase() + (risky ? ' · может не воспроизводиться' : ''))),
      h('div', { class: 'card-actions' },
        h('button', { class: 'btn small accent', html: icon('stage'), title: 'Вывести на сценический экран', onclick: () => void sendToStage(v) }),
        h('button', { class: 'icon-btn small', html: ICONS.settings, title: 'Настройки и переходы', onclick: () => void openVideoSettings(v) }),
        h('button', { class: 'icon-btn small danger', html: ICONS.trash, title: 'Удалить из библиотеки', onclick: () => void removeVideo(v) })));
    return card;
  }

  async function sendToStage(v: VideoItem): Promise<void> {
    try {
      await api.post('/api/stage/command', { action: 'load', payload: { videoId: v.id, autoplay: true } });
      toast('success', `«${v.title}» запущено на сценическом выводе`);
      navigate('stage');
    } catch (e) {
      const err = e as Error & { data?: { needConfirm?: boolean } };
      if (err.data && (err.data as { needConfirm?: boolean }).needConfirm) {
        navigate('stage');
      } else {
        toast('error', err.message);
      }
    }
  }

  async function removeVideo(v: VideoItem): Promise<void> {
    const ok = await confirmDialog('Удалить видео', `Удалить «${v.title}» из библиотеки? Файл на диске останется.`, 'Удалить', true);
    if (!ok) return;
    await api.del(`/api/videos/${v.id}`);
    void renderList();
  }

  async function openVideoSettings(v: VideoItem): Promise<void> {
    const { openVideoSettingsModal } = await import('./video-settings');
    const videos = (await api.get<{ videos: VideoItem[] }>('/api/videos')).videos;
    await openVideoSettingsModal(v, videos, () => void renderList());
  }

  // ─── Плейлисты видео ───

  async function createVideoPlaylist(): Promise<void> {
    const name = await promptDialog('Новый плейлист видео', 'Название');
    if (!name) return;
    await api.post('/api/video-playlists', { name });
    tab = 'playlists';
    void renderList();
  }

  async function renderVideoPlaylists(): Promise<void> {
    const [plsResp, videosResp] = await Promise.all([
      api.get<{ playlists: VideoPlaylist[] }>('/api/video-playlists'),
      api.get<{ videos: VideoItem[] }>('/api/videos')
    ]);
    const byId = new Map(videosResp.videos.map(v => [v.id, v]));
    clear(listWrap);
    if (plsResp.playlists.length === 0) {
      listWrap.append(emptyState(ICONS.playlist, 'Плейлистов видео нет', 'Создайте последовательность роликов для сценического вывода.',
        { label: 'Создать плейлист', onClick: () => void createVideoPlaylist() }));
      return;
    }
    const grid = h('div', { class: 'playlist-grid' });
    for (const pl of plsResp.playlists) {
      grid.append(h('div', { class: 'card pl-card' },
        h('div', { class: 'pl-cover empty', html: icon('playlist') }),
        h('div', { class: 'card-body' },
          h('div', { class: 'card-name' }, pl.name),
          h('div', { class: 'card-sub' }, `${pl.videoIds.length} ролик(ов)`)),
        h('div', { class: 'card-actions' },
          h('button', { class: 'btn small accent', html: icon('stage') + '<span>На экран</span>', onclick: async () => {
            const ids = pl.videoIds.filter(id => byId.has(id));
            if (ids.length === 0) { toast('info', 'В плейлисте нет доступных видео'); return; }
            await api.post('/api/stage/command', { action: 'setPlaylist', payload: { videoIds: ids } });
            await api.post('/api/stage/command', { action: 'load', payload: { videoId: ids[0], autoplay: true } });
            navigate('stage');
          } }),
          h('button', { class: 'icon-btn small', html: ICONS.settings, title: 'Состав плейлиста', onclick: () => void editVideoPlaylist(pl, videosResp.videos) }),
          h('button', { class: 'icon-btn small danger', html: ICONS.trash, onclick: async () => {
            const ok = await confirmDialog('Удалить плейлист', `Удалить «${pl.name}»?`, 'Удалить', true);
            if (!ok) return;
            await api.del(`/api/video-playlists/${pl.id}`);
            void renderList();
          } }))));
    }
    listWrap.append(grid);
  }

  async function editVideoPlaylist(pl: VideoPlaylist, videos: VideoItem[]): Promise<void> {
    modal(`Плейлист: ${pl.name}`, (body, close) => {
      const list = h('div', { class: 'track-list' }) as HTMLElement;
      const ids = [...pl.videoIds];
      const rebuild = (): void => {
        clear(list);
        ids.forEach((id, i) => {
          const v = videos.find(x => x.id === id);
          if (!v) return;
          list.append(h('div', { class: 'track-row' },
            h('span', { class: 'row-index' }, String(i + 1)),
            h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, v.title)),
            h('button', { class: 'icon-btn small', onclick: () => { ids.splice(i, 1); rebuild(); } }, '↑'),
            h('button', { class: 'icon-btn small danger', html: ICONS.close, onclick: () => { ids.splice(i, 1); rebuild(); } })));
        });
        if (ids.length === 0) list.append(h('div', { class: 'muted pad' }, 'Плейлист пуст'));
      };
      rebuild();
      const add = h('select', { class: 'input select' },
        h('option', { value: '' }, '— Добавить ролик —'),
        ...videos.filter(v => !v.missing).map(v => h('option', { value: v.id }, v.title))) as HTMLSelectElement;
      add.addEventListener('change', () => {
        if (!add.value) return;
        ids.push(add.value);
        add.value = '';
        rebuild();
      });
      body.append(add, list);
      body.append(h('div', { class: 'btn-row end' },
        h('button', { class: 'btn ghost', onclick: close }, 'Отмена'),
        h('button', { class: 'btn accent', onclick: async () => {
          await api.put(`/api/video-playlists/${pl.id}`, { videoIds: ids });
          close();
          void renderList();
        } }, 'Сохранить')));
    }, { wide: true });
  }

  void renderList();

  return {
    teardown: () => {
      video.pause();
      video.removeAttribute('src');
      window.clearInterval(progressTimer);
      window.clearInterval(maxTimer);
      void saveProgress();
    }
  };
}

function windowSonic(): { pickFolder(): Promise<string | null>; pickFiles(kind: string): Promise<string[]> } {
  const w = window as unknown as { sonicDesktop?: { pickFolder(): Promise<string | null>; pickFiles(kind: 'video'): Promise<string[]> } };
  if (!w.sonicDesktop) return { pickFolder: async () => null, pickFiles: async () => [] };
  return w.sonicDesktop;
}

/**
 * Фоновая генерация миниатюр: кадрируем видео в canvas и загружаем JPEG на сервер.
 * Работает последовательно, чтобы не нагружать систему.
 */
let thumbWorkerRunning = false;
export function startThumbWorker(): void {
  if (thumbWorkerRunning) return;
  thumbWorkerRunning = true;
  const tick = async (): Promise<void> => {
    try {
      const r = await api.get<{ videos: VideoItem[] }>('/api/videos');
      const target = r.videos.find(v => !v.thumbFile && !v.missing);
      if (target) {
        await generateThumb(target);
      }
    } catch { /* сеть недоступна — повторим позже */ }
    window.setTimeout(() => void tick(), 4000);
  };
  window.setTimeout(() => void tick(), 2500);
}

async function generateThumb(v: VideoItem): Promise<void> {
  return new Promise((resolve) => {
    const vid = document.createElement('video');
    vid.preload = 'metadata';
    vid.muted = true;
    vid.src = mediaUrl(`/api/media/video/${v.id}`);
    const cleanup = (): void => {
      vid.removeAttribute('src');
      vid.load();
      resolve();
    };
    const timer = window.setTimeout(cleanup, 20000);
    vid.addEventListener('loadedmetadata', () => {
      vid.currentTime = Math.min(Math.max(1, vid.duration * 0.2), 10);
    });
    vid.addEventListener('seeked', () => {
      try {
        const w = 480;
        const hgt = Math.max(120, Math.round(w * (vid.videoHeight || 270) / (vid.videoWidth || 480)));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = hgt;
        const ctx = canvas.getContext('2d');
        if (!ctx) { window.clearTimeout(timer); cleanup(); return; }
        ctx.drawImage(vid, 0, 0, w, hgt);
        canvas.toBlob(async (blob) => {
          window.clearTimeout(timer);
          if (blob) {
            try {
              await api.postRaw(`/api/videos/${v.id}/thumb`, blob);
              document.dispatchEvent(new CustomEvent('sonic:library-changed'));
            } catch { /* ignore */ }
          }
          cleanup();
        }, 'image/jpeg', 0.8);
      } catch {
        window.clearTimeout(timer);
        cleanup();
      }
    });
    vid.addEventListener('error', () => { window.clearTimeout(timer); cleanup(); });
  });
}

// Нужен для перехода на страницу сцены после вывода
import { navigate } from '../main';
void el;
