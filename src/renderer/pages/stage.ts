import { h, clear, el, fmtTime, toast, confirmDialog, makeSlider } from '../ui';
import { ICONS, icon } from '../icons';
import { api, isElectron } from '../api';
import { DisplayInfo, VideoItem, VideoPlaylist, Snapshot, ImageAsset } from '../../shared/types';
import { snapshotListener } from '../components';
import { store } from '../store';

/**
 * Сценический вывод: выбор дисплея (реальные данные Electron),
 * полный пульт сцены, чёрный экран, фейды, титры, QR для телефона.
 */
export function mountStage(container: HTMLElement): { teardown: () => void } {
  clear(container);
  const wrap = h('div', { class: 'page-wrap' });
  container.append(wrap);

  let snapshot: Snapshot | null = null;
  let videos: VideoItem[] = [];
  let playlists: VideoPlaylist[] = [];
  let images: ImageAsset[] = [];
  // Активный слайдер позиции сцены (обновляется одним общим интервалом)
  let stageProgress: { slider: ReturnType<typeof makeSlider>; label: HTMLElement } | null = null;
  window.setInterval(() => {
    if (stageProgress) {
      const pos = store.estimatePosition('stage');
      stageProgress.slider.setValue(pos, true);
      stageProgress.label.textContent = fmtTime(pos);
    }
  }, 700);

  const displaysBox = h('div', { class: 'display-grid' });
  const controlBox = h('div', { class: 'stage-controls' });
  const confirmBox = h('div', { class: 'confirm-banner hidden' });

  wrap.append(
    h('div', { class: 'page-head' },
      h('h2', { class: 'page-title' }, 'Сценический вывод'),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn ghost', html: icon('refresh') + '<span>Обновить дисплеи</span>', onclick: () => void cmd('refreshDisplays') }),
        h('button', { class: 'btn', html: icon('monitor') + '<span>Открыть окно вывода</span>', onclick: () => void cmd('openWindow') }),
        h('button', { class: 'btn ghost', html: icon('close') + '<span>Закрыть окно</span>', onclick: () => void cmd('closeWindow') }))),
    h('div', { class: 'section-title' }, '1. Выберите экран вывода'),
    displaysBox,
    h('div', { class: 'section-title' }, '2. Управление воспроизведением'),
    confirmBox,
    controlBox,
    h('div', { class: 'section-title' }, '3. Управление с телефона'),
    buildPhoneCard());

  async function refresh(): Promise<void> {
    try {
      const [v, p, imgs] = await Promise.all([
        api.get<{ videos: VideoItem[] }>('/api/videos'),
        api.get<{ playlists: VideoPlaylist[] }>('/api/video-playlists'),
        api.get<{ images: ImageAsset[] }>('/api/images')
      ]);
      videos = v.videos.filter(x => !x.missing);
      playlists = p.playlists;
      images = imgs.images;
    } catch { /* ignore */ }
  }

  async function cmd(action: string, payload: Record<string, unknown> = {}): Promise<void> {
    try {
      await api.post('/api/stage/command', { action, payload });
      if (action === 'refreshDisplays') toast('success', 'Дисплеи обновлены');
    } catch (e) {
      const err = e as Error & { data?: { needConfirm?: boolean } };
      if (err.data?.needConfirm) {
        // подтверждение показывается через снапшот
      } else {
        toast('error', err.message);
      }
    }
  }

  // ─── Дисплеи ───

  function renderDisplays(displays: DisplayInfo[], stage: Snapshot['stage']): void {
    clear(displaysBox);
    if (displays.length === 0) {
      displaysBox.append(h('div', { class: 'note-card' },
        'Дисплеи не обнаружены. Сценический вывод работает в приложении Sonic Studio на компьютере. Нажмите «Обновить дисплеи» после подключения монитора или проектора.'));
      return;
    }
    for (const d of displays) {
      const selected = stage.displayId === d.id;
      const card = h('button', { class: 'display-card' + (selected ? ' selected' : '') + (d.isStage ? ' stage' : ''),
        onclick: () => void cmd('setDisplay', { displayId: d.id }) },
        h('div', { class: 'display-head' },
          h('span', { class: 'display-name' }, d.label),
          d.isStage ? h('span', { class: 'badge' }, 'окно вывода здесь') : null),
        h('div', { class: 'display-specs' },
          `${d.bounds.width}×${d.bounds.height}` + (d.scaleFactor !== 1 ? ` · масштаб ${d.scaleFactor}x` : ''),
          h('br'),
          `позиция: x=${d.bounds.x}, y=${d.bounds.y}`),
        h('div', { class: 'display-status' + (d.available ? ' ok' : ' bad') },
          d.available ? '● доступен' : '● недоступен'));
      displaysBox.append(card);
    }
  }

  // ─── Подтверждение вывода при недоступном дисплее ───

  function renderConfirm(stage: Snapshot['stage']): void {
    clear(confirmBox);
    if (stage.pendingDisplayId === null) {
      confirmBox.classList.add('hidden');
      return;
    }
    confirmBox.classList.remove('hidden');
    confirmBox.append(
      h('span', {}, 'Выбранный дисплей недоступен. Запустить вывод на основной экран?'),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn accent small', onclick: () => void cmd('confirmDisplay', { accept: true }) }, 'Да, вывести на основной'),
        h('button', { class: 'btn ghost small', onclick: () => void cmd('confirmDisplay', { accept: false }) }, 'Отмена')));
  }

  // ─── Пульт сцены ───

  function renderControls(s: Snapshot): void {
    const stage = s.stage;
    clear(controlBox);

    // Статусная строка
    const status = h('div', { class: 'card stage-status' },
      h('div', { class: 'stage-status-grid' },
        statItem('Дисплей', stage.displayId === null ? 'не выбран' : (s.displays.find(d => d.id === stage.displayId)?.label || `ID ${stage.displayId}`)),
        statItem('Ролик', stage.videoTitle || '— не выбран —'),
        statItem('Состояние', statusText(stage.status) + (stage.blacked ? ' · чёрный экран' : '') + (stage.fullscreen ? ' · полный экран' : '')),
        statItem('На экране', stage.imageId ? `картинка: ${stage.imageTitle || 'без названия'}` : '—'),
        statItem('Время', `${fmtTime(store.estimatePosition('stage'))} / ${fmtTime(stage.duration)}`),
        statItem('Переход', stage.activeFade === 'in' ? 'Fade In идёт' : stage.activeFade === 'out' ? 'Fade Out идёт' : '—'),
        statItem('Следующий', stage.nextVideoTitle || '—')),
      h('div', { class: 'stage-progress-row' },
        progressSlider(stage)));

    // Плеер видео
    const playRow = h('div', { class: 'btn-row wrap' },
      h('button', { class: 'btn accent', html: ICONS.play + '<span>Запустить</span>', onclick: () => void cmd('play') }),
      h('button', { class: 'btn', html: ICONS.pause + '<span>Пауза</span>', onclick: () => void cmd('pause') }),
      h('button', { class: 'btn', html: ICONS.play + '<span>Продолжить</span>', onclick: () => void cmd('resume') }),
      h('button', { class: 'btn danger', html: ICONS.stop + '<span>Остановить</span>', onclick: () => void cmd('stop') }),
      h('button', { class: 'btn ghost', html: ICONS.prev + '<span>Предыдущий</span>', onclick: () => void cmd('prev') }),
      h('button', { class: 'btn ghost', html: ICONS.next + '<span>Следующий</span>', onclick: () => void cmd('next') }));

    // Экран и эффекты
    const screenRow = h('div', { class: 'btn-row wrap' },
      h('button', { class: 'btn', html: ICONS.fullscreen + '<span>Полный экран</span>', onclick: () => void cmd('fullscreen', { on: true }) }),
      h('button', { class: 'btn ghost', html: ICONS.fullscreen + '<span>Выйти из полного</span>', onclick: () => void cmd('fullscreen', { on: false }) }),
      h('button', { class: 'btn dark', html: ICONS.black + '<span>Чёрный экран</span>', onclick: () => void cmd('black') }),
      h('button', { class: 'btn', html: icon('image') + '<span>Вернуть изображение</span>', onclick: () => void cmd('restore') }),
      h('button', { class: 'btn ghost', html: icon('image') + '<span>Заставка</span>', onclick: () => void cmd('showSplash') }),
      h('button', { class: 'btn ghost', html: icon('editor') + `<span>Fade In (${stage.fadeIn.toFixed(1)} с)</span>`, onclick: () => void cmd('fadeIn') }),
      h('button', { class: 'btn ghost', html: icon('editor') + `<span>Fade Out (${stage.fadeOut.toFixed(1)} с)</span>`, onclick: () => void cmd('fadeOut') }));

    // Картинка на экране (заполняет экран целиком; видео останавливается)
    const imgSelect = h('select', { class: 'input select grow' },
      h('option', { value: '' }, images.length ? '— Картинка для экрана —' : '— Картинок нет: добавьте папку в настройках —'),
      ...images.map(i => h('option', { value: i.id, selected: stage.imageId === i.id ? '' : undefined },
        i.title + (i.missing ? ' (файл отсутствует)' : '')))) as HTMLSelectElement;
    const imageRow = h('div', { class: 'btn-row' },
      imgSelect,
      h('button', { class: 'btn accent', html: icon('image') + '<span>Показать</span>',
        onclick: () => { if (imgSelect.value) void cmd('showImage', { imageId: imgSelect.value }); else toast('info', 'Выберите картинку'); } }),
      h('button', { class: 'btn dark', onclick: () => void cmd('hideImage') }, 'Скрыть'));
    const imageRow2 = h('div', { class: 'btn-row' },
      h('button', { class: 'btn ghost small', html: icon('refresh') + '<span>Обновить список (скан папок)</span>',
        onclick: () => void rescanImages() }),
      isElectron() ? h('button', { class: 'btn small', html: icon('folderPlus') + '<span>Выбрать файл через проводник…</span>',
        onclick: () => void pickImages() }) : null);

    // Титры
    const textInput = h('input', { class: 'input', placeholder: 'Текст титров на экране' }) as HTMLInputElement;
    const textRow = h('div', { class: 'btn-row' },
      textInput,
      h('button', { class: 'btn', onclick: () => void cmd('showText', { text: textInput.value }) }, 'Показать'),
      h('button', { class: 'btn ghost', onclick: () => { textInput.value = ''; void cmd('hideText'); } }, 'Скрыть'));

    // Громкость
    const vol = makeSlider({ value: stage.muted ? 0 : stage.volume, max: 1, onInput: (v) => void cmd('setVolume', { volume: v }) });
    const volRow = h('div', { class: 'btn-row' },
      h('button', { class: 'icon-btn', html: stage.muted ? ICONS.volumeMute : ICONS.volume, onclick: () => void cmd('setMuted', { muted: !stage.muted }) }),
      vol.root,
      h('button', { class: 'btn ghost small' + (stage.repeat ? ' active' : ''), onclick: () => void cmd('setRepeat', { repeat: !stage.repeat }) }, 'Повтор'));

    // Загрузка контента
    const select = h('select', { class: 'input select grow' },
      h('option', { value: '' }, '— Выберите видео для сцены —'),
      ...videos.map(v => h('option', { value: v.id, selected: stage.videoId === v.id ? '' : undefined }, v.title))) as HTMLSelectElement;
    const plSelect = h('select', { class: 'input select grow' },
      h('option', { value: '' }, '— Плейлист видео —'),
      ...playlists.map(p => h('option', { value: p.id }, `${p.name} (${p.videoIds.length})`))) as HTMLSelectElement;
    plSelect.addEventListener('change', async () => {
      const pl = playlists.find(p => p.id === plSelect.value);
      if (!pl) return;
      const ids = pl.videoIds.filter(id => videos.some(v => v.id === id));
      await api.post('/api/stage/command', { action: 'setPlaylist', payload: { videoIds: ids } });
      toast('success', `Плейлист «${pl.name}» загружен в сцену`);
    });
    const loadRow = h('div', { class: 'btn-row' },
      select,
      h('button', { class: 'btn accent', onclick: () => { if (select.value) void cmd('load', { videoId: select.value, autoplay: true }); else toast('info', 'Выберите видео'); } }, 'Вывести и играть'),
      h('button', { class: 'btn', onclick: () => { if (select.value) void cmd('crossfadeTo', { videoId: select.value }); } }, 'Crossfade'),
      plSelect);

    controlBox.append(status, loadRow, playRow, screenRow,
      h('div', { class: 'form-row' }, h('label', { class: 'form-label' }, 'Картинка на экране'), imageRow),
      imageRow2,
      volRow, h('div', { class: 'form-row' }, h('label', { class: 'form-label' }, 'Титры'), textRow));
  }

  async function rescanImages(): Promise<void> {
    try {
      const r = await api.post<{ added: number; errors: string[] }>('/api/images/scan', {});
      const imgs = await api.get<{ images: ImageAsset[] }>('/api/images');
      images = imgs.images;
      if (snapshot) renderControls(snapshot);
      toast('success', `Скан картинок завершён: добавлено ${r.added}` + (r.errors.length ? `, ошибок ${r.errors.length}` : ''));
    } catch (e) { toast('error', (e as Error).message); }
  }

  async function pickImages(): Promise<void> {
    const w = window as unknown as { sonicDesktop?: { pickFiles(k: string): Promise<string[]> } };
    if (!w.sonicDesktop) return;
    let files: string[] = [];
    try { files = await w.sonicDesktop.pickFiles('image'); } catch { return; }
    if (!files.length) return;
    try {
      const r = await api.post<{ added: number; updated: number; errors: string[] }>('/api/images/files', { paths: files });
      const imgs = await api.get<{ images: ImageAsset[] }>('/api/images');
      images = imgs.images;
      if (snapshot) renderControls(snapshot);
      if (r.added > 0) toast('success', `Добавлено картинок: ${r.added}`);
      if (r.errors.length) toast('error', r.errors[0]);
    } catch (e) { toast('error', (e as Error).message); }
  }

  function progressSlider(stage: Snapshot['stage']): HTMLElement {
    const slider = makeSlider({
      value: store.estimatePosition('stage'),
      max: Math.max(1, stage.duration),
      onChange: (v) => void cmd('seek', { time: v })
    });
    const label = h('span', { class: 'pb-time' }, fmtTime(store.estimatePosition('stage')));
    stageProgress = { slider, label };
    return h('div', { class: 'pb-progress' }, label, slider.root, h('span', { class: 'pb-time' }, fmtTime(stage.duration)));
  }

  function statItem(label: string, value: string): HTMLElement {
    return h('div', { class: 'stat-item' }, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, value));
  }

  function statusText(s: Snapshot['stage']['status']): string {
    return { idle: 'ожидание', playing: 'воспроизведение', paused: 'пауза', stopped: 'остановлено' }[s];
  }

  // ─── QR / телефон ───

  function buildPhoneCard(): HTMLElement {
    const card = h('div', { class: 'card phone-card' });
    const info = h('div', { class: 'phone-info' });
    const img = h('img', { class: 'qr-img', alt: 'QR-код' }) as HTMLImageElement;
    card.append(info, img);
    const render = async (s: Snapshot): Promise<void> => {
      clear(info);
      info.append(
        h('div', { class: 'server-row' },
          h('span', { class: 'muted' }, 'Адрес для телефона:'),
          h('code', { class: 'addr' }, s.system.lanUrl || 'доступ по сети отключён')),
        h('div', { class: 'server-row' },
          h('span', { class: 'muted' }, 'PIN:'),
          h('code', { class: 'addr' }, s.system.pin),
          h('span', { class: 'muted' }, ' (вводится на телефоне при первом подключении)')));
      if (s.system.lanEnabled) {
        try {
          const r = await api.get<{ qr: string | null }>('/api/system/qr');
          if (r.qr) { img.src = r.qr; img.classList.remove('hidden'); }
          else img.classList.add('hidden');
        } catch { img.classList.add('hidden'); }
      } else {
        img.classList.add('hidden');
        info.append(h('button', { class: 'btn accent small', onclick: async () => {
          await api.post('/api/system/lan', { enabled: true });
          toast('success', 'Доступ по локальной сети включён');
        } }, 'Включить доступ по сети'));
      }
    };
    const off = snapshotListener((s) => void render(s));
    void off;
    return card;
  }

  const offSnap = snapshotListener((s) => {
    snapshot = s;
    renderDisplays(s.displays, s.stage);
    renderConfirm(s.stage);
    renderControls(s);
  });

  void el;
  void refresh().then(() => {
    if (snapshot) { renderControls(snapshot); }
  });

  return {
    teardown: () => { offSnap(); }
  };
}
