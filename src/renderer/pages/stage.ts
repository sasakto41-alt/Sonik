import { h, clear, el, fmtTime, toast, confirmDialog, promptDialog, modal, makeSlider } from '../ui';
import { ICONS, icon } from '../icons';
import { api, isElectron } from '../api';
import { DisplayInfo, VideoItem, VideoPlaylist, Snapshot, ImageAsset, DeviceEntry, DeviceType } from '../../shared/types';
import { snapshotListener } from '../components';
import { store } from '../store';

/**
 * Сценический вывод: выбор дисплея, меню устройств вывода (телефон/планшет/ТВ
 * с подключением по коду), полный пульт сцены, чёрный экран, фейды, титры, QR.
 *
 * Важно: панель управления строится ОДИН раз и затем только обновляется —
 * иначе любые клики по выпадающим спискам (выбор видео/картинки) сбрасывались
 * снапшотами состояния, которые приходят каждые ~0.5 с во время показа.
 */

type CmdResult = { ok: boolean; error?: string; needConfirm?: boolean } | null;

export function mountStage(container: HTMLElement): { teardown: () => void } {
  clear(container);
  const wrap = h('div', { class: 'page-wrap' });
  container.append(wrap);

  let snapshot: Snapshot | null = null;
  let videos: VideoItem[] = [];
  let playlists: VideoPlaylist[] = [];
  let images: ImageAsset[] = [];

  // ─── Контейнеры разделов ───

  const displaysBox = h('div', { class: 'display-grid' });
  const devicesBox = h('div', { class: 'devices-box' });
  const confirmBox = h('div', { class: 'confirm-banner hidden' });
  const controlBox = h('div', { class: 'stage-controls' });

  wrap.append(
    h('div', { class: 'page-head' },
      h('h2', { class: 'page-title' }, 'Сценический вывод'),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn ghost', html: icon('refresh') + '<span>Обновить дисплеи</span>', onclick: () => void cmd('refreshDisplays') }),
        h('button', { class: 'btn', html: icon('monitor') + '<span>Открыть окно вывода</span>', onclick: () => void cmd('openWindow') }),
        h('button', { class: 'btn ghost', html: icon('close') + '<span>Закрыть окно</span>', onclick: () => void cmd('closeWindow') }))),
    h('div', { class: 'section-title' }, '1. Экран вывода'),
    displaysBox,
    h('div', { class: 'section-title' }, '2. Устройства вывода — телефон, планшет, ТВ'),
    devicesBox,
    h('div', { class: 'section-title' }, '3. Управление воспроизведением'),
    confirmBox,
    controlBox,
    h('div', { class: 'section-title' }, '4. Управление с телефона'),
    buildPhoneCard());

  // ─── Данные библиотеки ───

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
      rebuildSelectOptions();
    } catch { /* ignore */ }
  }

  async function cmd(action: string, payload: Record<string, unknown> = {}): Promise<CmdResult> {
    try {
      const r = await api.post<CmdResult>('/api/stage/command', { action, payload });
      if (action === 'refreshDisplays') toast('success', 'Дисплеи обновлены');
      return r;
    } catch (e) {
      const err = e as Error & { data?: { needConfirm?: boolean } };
      if (!err.data?.needConfirm) toast('error', err.message);
      return null;
    }
  }

  // ─── Панель управления: строится один раз ───

  interface Controls {
    stat: { disp: HTMLElement; vid: HTMLElement; state: HTMLElement; img: HTMLElement; fade: HTMLElement; next: HTMLElement };
    progress: ReturnType<typeof makeSlider>;
    posLabel: HTMLElement;
    durLabel: HTMLElement;
    loadSelect: HTMLSelectElement;
    imgSelect: HTMLSelectElement;
    plSelect: HTMLSelectElement;
    vol: ReturnType<typeof makeSlider>;
    muteBtn: HTMLButtonElement;
    repeatBtn: HTMLButtonElement;
    fadeInLabel: HTMLElement;
    fadeOutLabel: HTMLElement;
  }
  let ctl: Controls | null = null;

  function statItem(label: string): { row: HTMLElement; value: HTMLElement } {
    const value = h('div', { class: 'stat-value' }, '—');
    return { row: h('div', { class: 'stat-item' }, h('div', { class: 'stat-label' }, label), value), value };
  }

  function buildControls(): void {
    // Статусная строка
    const sDisp = statItem('Дисплей');
    const sVid = statItem('Ролик');
    const sState = statItem('Состояние');
    const sImg = statItem('На экране');
    const sFade = statItem('Переход');
    const sNext = statItem('Следующий');

    // Прогресс
    const posLabel = h('span', { class: 'pb-time' }, '0:00');
    const durLabel = h('span', { class: 'pb-time' }, '0:00');
    const progress = makeSlider({
      value: 0, max: 1,
      onChange: (v) => void cmd('seek', { time: v })
    });
    const progressRow = h('div', { class: 'stage-progress-row' },
      h('div', { class: 'pb-progress' }, posLabel, progress.root, durLabel));

    // Выбор контента
    const loadSelect = h('select', { class: 'input select grow' }) as HTMLSelectElement;
    const imgSelect = h('select', { class: 'input select grow' }) as HTMLSelectElement;
    const plSelect = h('select', { class: 'input select grow' }) as HTMLSelectElement;
    // Пользовательский выбор не сбрасывается снапшотами, пока не выполнено действие
    loadSelect.addEventListener('change', () => { loadSelect.dataset.user = '1'; });
    imgSelect.addEventListener('change', () => { imgSelect.dataset.user = '1'; });
    plSelect.addEventListener('change', async () => {
      const pl = playlists.find(p => p.id === plSelect.value);
      if (!pl) return;
      const ids = pl.videoIds.filter(id => videos.some(v => v.id === id));
      await api.post('/api/stage/command', { action: 'setPlaylist', payload: { videoIds: ids } });
      toast('success', `Плейлист «${pl.name}» загружен в сцену`);
    });

    const loadRow = h('div', { class: 'btn-row' },
      loadSelect,
      h('button', {
        class: 'btn accent', onclick: async () => {
          const id = loadSelect.value;
          if (!id) { toast('info', 'Выберите видео'); return; }
          const r = await cmd('load', { videoId: id, autoplay: true });
          if (r && r.ok !== false) { delete loadSelect.dataset.user; syncSelects(); }
        }
      }, 'Вывести и играть'),
      h('button', { class: 'btn', onclick: () => { if (loadSelect.value) void cmd('crossfadeTo', { videoId: loadSelect.value }); } }, 'Crossfade'),
      plSelect);

    const imageRow = h('div', { class: 'btn-row' },
      imgSelect,
      h('button', {
        class: 'btn accent', html: icon('image') + '<span>Показать</span>',
        onclick: async () => {
          const id = imgSelect.value;
          if (!id) { toast('info', 'Выберите картинку'); return; }
          const r = await cmd('showImage', { imageId: id });
          if (r && r.ok !== false) { delete imgSelect.dataset.user; syncSelects(); }
        }
      }),
      h('button', { class: 'btn dark', onclick: () => void cmd('hideImage') }, 'Скрыть'));
    const imageRow2 = h('div', { class: 'btn-row' },
      h('button', { class: 'btn ghost small', html: icon('refresh') + '<span>Обновить список (скан папок)</span>',
        onclick: () => void rescanImages() }),
      isElectron() ? h('button', { class: 'btn small', html: icon('folderPlus') + '<span>Выбрать файл через проводник…</span>',
        onclick: () => void pickImages() }) : null);

    // Громкость и повтор
    const vol = makeSlider({ value: 1, max: 1, onInput: (v) => void cmd('setVolume', { volume: v }) });
    const muteBtn = h('button', { class: 'icon-btn', html: ICONS.volume, onclick: () => void cmd('setMuted', { muted: !(snapshot?.stage.muted) }) }) as HTMLButtonElement;
    const repeatBtn = h('button', { class: 'btn ghost small', onclick: () => void cmd('setRepeat', { repeat: !(snapshot?.stage.repeat) }) }, 'Повтор') as HTMLButtonElement;
    const volRow = h('div', { class: 'btn-row' }, muteBtn, vol.root, repeatBtn);

    // Фейды (подписи обновляются)
    const fadeInLabel = h('span', {}, 'Fade In');
    const fadeOutLabel = h('span', {}, 'Fade Out');

    ctl = {
      stat: { disp: sDisp.value, vid: sVid.value, state: sState.value, img: sImg.value, fade: sFade.value, next: sNext.value },
      progress, posLabel, durLabel,
      loadSelect, imgSelect, plSelect,
      vol, muteBtn, repeatBtn,
      fadeInLabel, fadeOutLabel
    };

    controlBox.append(
      h('div', { class: 'card stage-status' },
        h('div', { class: 'stage-status-grid' },
          sDisp.row, sVid.row, sState.row, sImg.row, sFade.row, sNext.row),
        progressRow),
      loadRow,
      h('div', { class: 'btn-row wrap' },
        h('button', { class: 'btn accent', html: ICONS.play + '<span>Запустить</span>', onclick: () => void cmd('play') }),
        h('button', { class: 'btn', html: ICONS.pause + '<span>Пауза</span>', onclick: () => void cmd('pause') }),
        h('button', { class: 'btn', html: ICONS.play + '<span>Продолжить</span>', onclick: () => void cmd('resume') }),
        h('button', { class: 'btn danger', html: ICONS.stop + '<span>Остановить</span>', onclick: () => void cmd('stop') }),
        h('button', { class: 'btn ghost', html: ICONS.prev + '<span>Предыдущий</span>', onclick: () => void cmd('prev') }),
        h('button', { class: 'btn ghost', html: ICONS.next + '<span>Следующий</span>', onclick: () => void cmd('next') })),
      h('div', { class: 'btn-row wrap' },
        h('button', { class: 'btn', html: ICONS.fullscreen + '<span>Полный экран</span>', onclick: () => void cmd('fullscreen', { on: true }) }),
        h('button', { class: 'btn ghost', html: ICONS.fullscreen + '<span>Выйти из полного</span>', onclick: () => void cmd('fullscreen', { on: false }) }),
        h('button', { class: 'btn dark', html: ICONS.black + '<span>Чёрный экран</span>', onclick: () => void cmd('black') }),
        h('button', { class: 'btn', html: icon('image') + '<span>Вернуть изображение</span>', onclick: () => void cmd('restore') }),
        h('button', { class: 'btn ghost', html: icon('image') + '<span>Заставка</span>', onclick: () => void cmd('showSplash') }),
        h('button', { class: 'btn ghost', html: icon('editor') + fadeInLabel, onclick: () => void cmd('fadeIn') }),
        h('button', { class: 'btn ghost', html: icon('editor') + fadeOutLabel, onclick: () => void cmd('fadeOut') })),
      h('div', { class: 'form-row' }, h('label', { class: 'form-label' }, 'Картинка на экране'), imageRow),
      imageRow2,
      volRow,
      (() => {
        const textInput = h('input', { class: 'input', placeholder: 'Текст титров на экране' }) as HTMLInputElement;
        const textRow = h('div', { class: 'btn-row' },
          textInput,
          h('button', { class: 'btn', onclick: () => void cmd('showText', { text: textInput.value }) }, 'Показать'),
          h('button', { class: 'btn ghost', onclick: () => { textInput.value = ''; void cmd('hideText'); } }, 'Скрыть'));
        return h('div', { class: 'form-row' }, h('label', { class: 'form-label' }, 'Титры'), textRow);
      })());
  }

  /** Перестроить варианты выбора (после скана/проводника), сохраняя выбранные значения. */
  function rebuildSelectOptions(): void {
    if (!ctl) return;
    const lv = ctl.loadSelect.value;
    clear(ctl.loadSelect);
    ctl.loadSelect.append(h('option', { value: '' }, '— Выберите видео для сцены —'));
    for (const v of videos) ctl.loadSelect.append(h('option', { value: v.id }, v.title));
    ctl.loadSelect.value = lv;

    const iv = ctl.imgSelect.value;
    clear(ctl.imgSelect);
    ctl.imgSelect.append(h('option', { value: '' }, images.length ? '— Картинка для экрана —' : '— Картинок нет: добавьте папку в настройках —'));
    for (const i of images) ctl.imgSelect.append(h('option', { value: i.id }, i.title + (i.missing ? ' (файл отсутствует)' : '')));
    ctl.imgSelect.value = iv;

    clear(ctl.plSelect);
    ctl.plSelect.append(h('option', { value: '' }, '— Плейлист видео —'));
    for (const p of playlists) ctl.plSelect.append(h('option', { value: p.id }, `${p.name} (${p.videoIds.length})`));
  }

  /** Синхронизация выпадающих списков с состоянием сцены. */
  function syncSelects(): void {
    if (!ctl || !snapshot) return;
    syncSel(ctl.loadSelect, snapshot.stage.videoId || '');
    syncSel(ctl.imgSelect, snapshot.stage.imageId || '');
  }

  function syncSel(sel: HTMLSelectElement, value: string): void {
    if (document.activeElement === sel) return;   // пользователь сейчас выбирает
    if (sel.dataset.user === '1') return;         // пользовательский выбор ждёт действия
    if (sel.value !== value) sel.value = value;
  }

  // ─── Обновление панели (без пересоздания DOM) ───

  function updateControls(s: Snapshot): void {
    if (!ctl) { buildControls(); rebuildSelectOptions(); }
    const c = ctl!;
    const st = s.stage;

    c.stat.disp.textContent = st.displayId === null ? 'не выбран' : (s.displays.find(d => d.id === st.displayId)?.label || `ID ${st.displayId}`);
    c.stat.vid.textContent = st.videoTitle || '— не выбран —';
    c.stat.state.textContent = statusText(st.status) + (st.blacked ? ' · чёрный экран' : '') + (st.fullscreen ? ' · полный экран' : '');
    c.stat.img.textContent = st.imageId ? `картинка: ${st.imageTitle || 'без названия'}` : '—';
    c.stat.fade.textContent = st.activeFade === 'in' ? 'Fade In идёт' : st.activeFade === 'out' ? 'Fade Out идёт' : '—';
    c.stat.next.textContent = st.nextVideoTitle || '—';

    c.durLabel.textContent = fmtTime(st.duration);
    c.progress.setMax(Math.max(1, st.duration));
    if (!c.progress.root.classList.contains('dragging')) {
      const pos = store.estimatePosition('stage');
      c.progress.setValue(pos, true);
      c.posLabel.textContent = fmtTime(pos);
    }

    c.fadeInLabel.textContent = `Fade In (${st.fadeIn.toFixed(1)} с)`;
    c.fadeOutLabel.textContent = `Fade Out (${st.fadeOut.toFixed(1)} с)`;
    c.repeatBtn.classList.toggle('active', st.repeat);
    if (!c.vol.root.classList.contains('dragging')) c.vol.setValue(st.muted ? 0 : st.volume, true);
    c.muteBtn.innerHTML = st.muted ? ICONS.volumeMute : ICONS.volume;

    syncSelects();
    renderConfirm(st);
  }

  // ─── Дисплеи ───

  function renderDisplays(displays: DisplayInfo[], stage: Snapshot['stage']): void {
    clear(displaysBox);
    if (displays.length === 0) {
      displaysBox.append(h('div', { class: 'note-card' },
        'Дисплеи не обнаружены. Сценический вывод работает в приложении Sonic Studio на компьютере. Нажмите «Обновить дисплеи» после подключения монитора или проектора. Показать видео и картинки можно также на устройствах из раздела 2 ниже.'));
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

  // ─── Устройства вывода ───

  const TYPE_LABEL: Record<DeviceType, string> = {
    phone: 'телефон', tablet: 'планшет', desktop: 'компьютер', tv: 'ТВ', web: 'браузер'
  };

  function fmtAgo(ts: number): string {
    const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (sec < 60) return 'только что';
    const m = Math.floor(sec / 60);
    if (m < 60) return `${m} мин назад`;
    const hh = Math.floor(m / 60);
    if (hh < 24) return `${hh} ч назад`;
    return `${Math.floor(hh / 24)} дн назад`;
  }

  function renderDevices(devices: DeviceEntry[]): void {
    clear(devicesBox);
    const lanEnabled = store.snapshot?.system.lanEnabled ?? true;
    if (!lanEnabled) {
      devicesBox.append(h('div', { class: 'note-card' },
        h('div', {}, 'Доступ по локальной сети выключен — устройства не смогут подключаться к сайту.'),
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn accent small', onclick: () => void enableLan() }, 'Включить доступ по сети'))));
      return;
    }
    if (devices.length === 0) {
      const url = store.snapshot?.system.lanUrl;
      devicesBox.append(h('div', { class: 'note-card' },
        h('div', {}, 'Устройств пока нет. Откройте на телефоне, планшете или ТВ адрес сайта Sonic Studio — устройство появится здесь автоматически и сохранится, даже если закрыть приложение.'),
        url ? h('div', { class: 'server-row' }, h('span', { class: 'muted' }, 'Адрес:'), h('code', { class: 'addr' }, url)) : null,
        h('div', { class: 'muted' }, 'Затем нажмите «Подключить» и введите код (PIN) — после этого на устройство можно вывести сцену.')));
      return;
    }
    const grid = h('div', { class: 'device-grid' });
    for (const d of devices) grid.append(deviceCard(d));
    devicesBox.append(grid);
  }

  function deviceCard(d: DeviceEntry): HTMLElement {
    const canOutput = d.paired && d.online && !d.showsStage;
    return h('div', { class: 'device-card' + (d.online ? ' online' : '') + (d.showsStage ? ' staging' : '') },
      h('div', { class: 'device-head' },
        h('span', { class: 'device-icon', html: icon('cast') }),
        h('span', { class: 'device-name' }, d.name),
        h('span', { class: 'device-type' }, TYPE_LABEL[d.type] || 'устройство'),
        h('span', { class: 'device-status ' + (d.online ? 'ok' : 'off') },
          d.online ? '● в сети' : `○ был(а) ${fmtAgo(d.lastSeen)}`)),
      h('div', { class: 'device-badges' },
        d.paired ? h('span', { class: 'badge ok', html: icon('check') + '<span>подключено</span>' }) : h('span', { class: 'badge' }, 'не подключено'),
        d.showsStage ? h('span', { class: 'badge accent' }, 'показывает сцену') : null),
      h('div', { class: 'btn-row' },
        d.paired
          ? h('button', { class: 'btn accent small', disabled: canOutput ? undefined : '', title: canOutput ? 'Показать сцену на этом устройстве' : (d.showsStage ? 'Сцена уже показывается' : 'Устройство не в сети'), onclick: () => void outputTo(d) }, 'Вывести сцену')
          : h('button', { class: 'btn accent small', onclick: () => pairModal(d) }, 'Подключить'),
        h('button', { class: 'icon-btn small', title: 'Переименовать', html: ICONS.edit, onclick: () => void renameDevice(d) }),
        h('button', { class: 'icon-btn small', title: 'Забыть устройство', html: ICONS.trash, onclick: () => void forgetDevice(d) })));
  }

  /** Диалог подключения: просим код (PIN) и подтверждаем устройство. */
  function pairModal(d: DeviceEntry): void {
    modal('Подключение устройства', (body, close) => {
      body.append(h('p', { class: 'confirm-text' },
        `Устройство: «${d.name}». Введите код подключения — он отображается в настройках Sonic Studio, раздел «Сервер и доступ».`));
      const input = h('input', { class: 'input', type: 'text', inputmode: 'numeric', placeholder: 'Код (PIN)', maxlength: '8' }) as HTMLInputElement;
      const err = h('div', { class: 'form-error hidden' }) as HTMLElement;
      const btn = h('button', { class: 'btn accent full' }, 'Подключить');
      const submit = async (): Promise<void> => {
        try {
          await api.post('/api/devices/pair', { id: d.id, pin: input.value.trim() });
          err.classList.add('hidden');
          close();
          toast('success', `Устройство «${d.name}» подключено и сохранено`);
          // Если устройство сейчас на сайте — сразу предложим вывести сцену
          try {
            const list = await api.get<{ devices: DeviceEntry[] }>(`/api/devices?_=${Date.now()}`);
            const fresh = list.devices.find(x => x.id === d.id);
            if (fresh?.online && !fresh.showsStage) {
              const yes = await confirmDialog('Вывести сцену?',
                `«${fresh.name}» сейчас на сайте. Переключить его в режим показа сцены?`,
                'Вывести сцену');
              if (yes) void outputTo(fresh);
            }
          } catch { /* ignore */ }
        } catch (e) {
          err.textContent = (e as Error).message;
          err.classList.remove('hidden');
        }
      };
      btn.addEventListener('click', () => void submit());
      input.addEventListener('keydown', e => { if (e.key === 'Enter') void submit(); });
      body.append(input, err, btn);
      window.setTimeout(() => input.focus(), 60);
    });
  }

  async function outputTo(d: DeviceEntry): Promise<void> {
    try {
      await api.post(`/api/devices/${d.id}/output`, {});
      toast('success', `Сцена выведена на «${d.name}»`);
    } catch (e) {
      toast('error', (e as Error).message);
    }
  }

  async function renameDevice(d: DeviceEntry): Promise<void> {
    const name = await promptDialog('Название устройства', 'Например: «ТВ в зале»', d.name);
    if (!name) return;
    try {
      await api.post(`/api/devices/${d.id}/rename`, { name });
      toast('success', 'Название сохранено');
    } catch (e) { toast('error', (e as Error).message); }
  }

  async function forgetDevice(d: DeviceEntry): Promise<void> {
    const ok = await confirmDialog('Забыть устройство?', `«${d.name}» будет удалено из списка. Если оно снова откроет сайт — появится автоматически.`, 'Забыть', true);
    if (!ok) return;
    try {
      await api.del(`/api/devices/${d.id}`);
      toast('success', 'Устройство удалено из списка');
    } catch (e) { toast('error', (e as Error).message); }
  }

  async function enableLan(): Promise<void> {
    try {
      await api.post('/api/system/lan', { enabled: true });
      toast('success', 'Доступ по локальной сети включён');
    } catch (e) { toast('error', (e as Error).message); }
  }

  async function refreshDevices(): Promise<void> {
    try {
      const r = await api.get<{ devices: DeviceEntry[] }>(`/api/devices?_=${Date.now()}`);
      renderDevices(r.devices);
    } catch { /* ignore */ }
  }

  // ─── Скан картинок / проводник ───

  async function rescanImages(): Promise<void> {
    try {
      const r = await api.post<{ added: number; errors: string[] }>('/api/images/scan', {});
      const imgs = await api.get<{ images: ImageAsset[] }>('/api/images');
      images = imgs.images;
      rebuildSelectOptions();
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
      rebuildSelectOptions();
      if (r.added > 0) toast('success', `Добавлено картинок: ${r.added}`);
      if (r.errors.length) toast('error', r.errors[0]);
    } catch (e) { toast('error', (e as Error).message); }
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
        info.append(h('button', { class: 'btn accent small', onclick: () => void enableLan() }, 'Включить доступ по сети'));
      }
    };
    const off = snapshotListener((s) => void render(s));
    void off;
    return card;
  }

  // ─── Живая позиция прогресса ───

  window.setInterval(() => {
    if (ctl && !ctl.progress.root.classList.contains('dragging')) {
      const pos = store.estimatePosition('stage');
      ctl.progress.setValue(pos, true);
      ctl.posLabel.textContent = fmtTime(pos);
    }
  }, 700);

  // ─── Подписка на состояние ───

  const offSnap = snapshotListener((s) => {
    snapshot = s;
    renderDisplays(s.displays, s.stage);
    renderDevices(s.devices);
    updateControls(s);
  });

  void el;
  void refresh().then(() => { void refreshDevices(); });

  return {
    teardown: () => { offSnap(); }
  };
}
