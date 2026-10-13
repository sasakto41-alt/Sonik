import { h, clear, el, toast, confirmDialog, fmtDate } from '../ui';
import { ICONS, icon } from '../icons';
import { api, isElectron } from '../api';
import { Settings, MAX_FADE_SECONDS } from '../../shared/types';
import { snapshotListener } from '../components';

/**
 * Настройки: медиапапки, сервер и доступ (порт, LAN, PIN, QR),
 * значения по умолчанию для переходов, crossfade, заставка,
 * резервное копирование, журналы, информация.
 */
export function mountSettings(container: HTMLElement): { teardown: () => void } {
  clear(container);
  const wrap = h('div', { class: 'page-wrap' });
  container.append(wrap);

  async function render(): Promise<void> {
    clear(wrap);
    wrap.append(h('div', { class: 'spinner-wrap' }, h('div', { class: 'spinner' })));
    let settings: Settings;
    try {
      settings = (await api.get<{ settings: Settings }>('/api/settings')).settings;
    } catch {
      clear(wrap);
      return;
    }
    clear(wrap);

    wrap.append(h('div', { class: 'page-head' }, h('h2', { class: 'page-title' }, 'Настройки')));

    // ─── Медиапапки ───
    const musicList = folderList(settings.musicFolders, async (folders) => {
      await api.put('/api/settings', { musicFolders: folders });
      toast('success', 'Папки музыки обновлены');
      void render();
    });
    const videoList = folderList(settings.videoFolders, async (folders) => {
      await api.put('/api/settings', { videoFolders: folders });
      toast('success', 'Папки видео обновлены');
      void render();
    });
    const imageList = folderList(settings.imageFolders, async (folders) => {
      await api.put('/api/settings', { imageFolders: folders });
      toast('success', 'Папки картинок обновлены');
      void render();
    });
    wrap.append(section('Медиапапки',
      h('div', { class: 'folder-block' },
        h('div', { class: 'form-label' }, 'Музыка (файлы остаются в своих папках, копирования нет)'),
        musicList,
        isElectron() ? h('button', { class: 'btn small', html: icon('folderPlus') + '<span>Добавить папку музыки</span>',
          onclick: () => void addFolder(settings.musicFolders, async (folders) => {
            await api.put('/api/settings', { musicFolders: folders });
            await api.post('/api/music/scan', {});
            toast('info', 'Сканирование запущено');
            void render();
          }) }) : h('div', { class: 'muted' }, 'Добавление папок доступно в приложении на компьютере')),
      h('div', { class: 'folder-block' },
        h('div', { class: 'form-label' }, 'Видео'),
        videoList,
        isElectron() ? h('button', { class: 'btn small', html: icon('folderPlus') + '<span>Добавить папку видео</span>',
          onclick: () => void addFolder(settings.videoFolders, async (folders) => {
            await api.put('/api/settings', { videoFolders: folders });
            await api.post('/api/videos/scan', {});
            toast('info', 'Сканирование запущено');
            void render();
          }) }) : h('span')),
      h('div', { class: 'folder-block' },
        h('div', { class: 'form-label' }, 'Картинки для сценического вывода (JPG, PNG, GIF, WEBP, BMP)'),
        imageList,
        isElectron() ? h('button', { class: 'btn small', html: icon('folderPlus') + '<span>Добавить папку картинок</span>',
          onclick: () => void addFolder(settings.imageFolders, async (folders) => {
            await api.put('/api/settings', { imageFolders: folders });
            await api.post('/api/images/scan', {});
            toast('info', 'Папка добавлена, список картинок обновляется');
            void render();
          }) }) : h('span'))));

    // ─── Сервер и доступ ───
    const portInput = h('input', { class: 'input', type: 'number', value: String(settings.port), min: '1024', max: '65535' }) as HTMLInputElement;
    const lanCheck = h('input', { type: 'checkbox', checked: settings.lanEnabled ? '' : undefined }) as HTMLInputElement;
    const qrImg = h('img', { class: 'qr-img', alt: 'QR' }) as HTMLImageElement;
    const serverCard = section('Сервер и доступ с других устройств',
      h('div', { class: 'form-row' },
        h('label', { class: 'form-label' }, 'Порт (применится сразу)'),
        h('div', { class: 'btn-row' }, portInput,
          h('button', { class: 'btn small', onclick: async () => {
            try {
              await api.post('/api/system/port', { port: Number(portInput.value) });
              toast('success', 'Порт изменён. Обновите адрес в браузере.');
            } catch (e) { toast('error', (e as Error).message); }
          } }, 'Применить'))),
      h('div', { class: 'form-row' },
        h('label', { class: 'form-label' }, 'Доступ по локальной сети'),
        h('label', { class: 'check-label' }, lanCheck, ' разрешить подключение с телефона и других устройств'),
        h('button', { class: 'btn small', onclick: async () => {
          await api.post('/api/system/lan', { enabled: lanCheck.checked });
          toast('success', lanCheck.checked ? 'Доступ по сети включён' : 'Доступ по сети выключен');
          void render();
        } }, 'Применить')),
      h('div', { class: 'form-row' },
        h('label', { class: 'form-label' }, 'PIN-код для подключения'),
        h('code', { class: 'addr' }, settings.lanPin),
        h('button', { class: 'btn ghost small', onclick: async () => {
          const ok = await confirmDialog('Новый PIN', 'Сгенерировать новый PIN и токен? Все подключённые устройства потребуют повторный вход.', 'Сгенерировать');
          if (!ok) return;
          await api.post('/api/system/pin/regenerate', {});
          toast('success', 'PIN обновлён');
          void render();
        } }, 'Обновить')),
      h('div', { class: 'qr-wrap' }, qrImg));
    wrap.append(serverCard);
    void api.get<{ qr: string | null }>('/api/system/qr').then(r => {
      if (r.qr) { qrImg.src = r.qr; qrImg.classList.remove('hidden'); }
    }).catch(() => {});

    // ─── Быстрый доступ на главной (только в приложении на компьютере) ───
    if (isElectron()) {
      try {
        const q = await api.get<{ config: { enabled: boolean; tiles: unknown[] } }>('/api/quick');
        const quickCheck = h('input', { type: 'checkbox', checked: q.config.enabled ? '' : undefined }) as HTMLInputElement;
        const tilesNote = h('span', { class: 'muted' },
          q.config.enabled ? ` (плиток: ${q.config.tiles.length})` : '');
        wrap.append(section('Быстрый доступ на главной',
          h('div', { class: 'form-row' },
            h('label', { class: 'form-label' }, 'Собственная сетка быстрого доступа'),
            h('label', { class: 'check-label' }, quickCheck,
              ' показывать плитки на главном экране', tilesNote),
            h('button', { class: 'btn small', onclick: async () => {
              try {
                await api.put('/api/quick', { enabled: quickCheck.checked });
                toast('success', quickCheck.checked
                  ? 'Быстрый доступ включён — плитки на главном экране'
                  : 'Быстрый доступ выключен');
                void render();
              } catch (e) { toast('error', (e as Error).message); }
            } }, 'Применить')),
          h('div', { class: 'muted note' },
            'Плитки живут прямо на главном экране — никакого отдельного раздела: действия плеера, треки, плейлисты, звуки Soundboard, разделы и команды сцены. Название трека, плей/пауза и громкость — в панели плеера внизу окна. Плитки перетаскиваются мышью, размер меняется кнопкой S/M/L.')));
      } catch { /* раздел просто не показывается */ }
    }

    // ─── Переходы и звук по умолчанию ───
    const fadeIn = rangeInput('Fade In по умолчанию', settings.defaults.fadeIn);
    const fadeOut = rangeInput('Fade Out по умолчанию', settings.defaults.fadeOut);
    const vol = rangeInput('Громкость видео по умолчанию', settings.defaults.volume, 0, 1, 0.05, v => Math.round(v * 100) + '%');
    const afterSel = h('select', { class: 'input select' },
      h('option', { value: 'stop', selected: settings.defaults.afterAction === 'stop' ? '' : undefined }, 'Стоп'),
      h('option', { value: 'black', selected: settings.defaults.afterAction === 'black' ? '' : undefined }, 'Затемнить'),
      h('option', { value: 'next', selected: settings.defaults.afterAction === 'next' ? '' : undefined }, 'Следующий'),
      h('option', { value: 'loop', selected: settings.defaults.afterAction === 'loop' ? '' : undefined }, 'Зациклить')) as HTMLSelectElement;
    const crossCheck = h('input', { type: 'checkbox', checked: settings.crossfade.enabled ? '' : undefined }) as HTMLInputElement;
    const crossDur = rangeInput('Длительность crossfade', settings.crossfade.duration, 0.5, MAX_FADE_SECONDS, 0.5, v => v.toFixed(1) + ' с');
    const splashCheck = h('input', { type: 'checkbox', checked: settings.splash.enabled ? '' : undefined }) as HTMLInputElement;
    const splashText = h('input', { class: 'input', value: settings.splash.text }) as HTMLInputElement;
    const defaultsCard = section('Переходы, звук и заставка (значения по умолчанию для новых роликов)',
      fadeIn.row, fadeOut.row, vol.row,
      h('div', { class: 'form-row' }, h('label', { class: 'form-label' }, 'Действие после завершения'), afterSel),
      h('div', { class: 'form-row' }, h('label', { class: 'form-label' }, 'Crossfade между роликами (двойное декодирование)'),
        h('label', { class: 'check-label' }, crossCheck, ' включить'), crossDur.row),
      h('div', { class: 'form-row' }, h('label', { class: 'form-label' }, 'Заставка сцены'), h('label', { class: 'check-label' }, splashCheck, ' показывать')),
      h('div', { class: 'form-row' }, h('label', { class: 'form-label' }, 'Текст заставки'), splashText),
      h('div', { class: 'btn-row end' }, h('button', { class: 'btn accent', onclick: async () => {
        await api.put('/api/settings', {
          defaults: { ...settings.defaults, fadeIn: fadeIn.value, fadeOut: fadeOut.value, volume: vol.value, afterAction: afterSel.value },
          crossfade: { enabled: crossCheck.checked, duration: crossDur.value },
          splash: { enabled: splashCheck.checked, text: splashText.value, imagePath: settings.splash.imagePath }
        });
        toast('success', 'Настройки сохранены');
      } }, 'Сохранить')));
    wrap.append(defaultsCard);

    // ─── Данные и резервные копии ───
    wrap.append(section('Данные и резервные копии',
      h('div', { class: 'btn-row wrap' },
        h('a', { class: 'btn', href: '/api/system/backup', download: 'sonic-studio-backup.json' }, 'Скачать резервную копию настроек'),
        h('label', { class: 'btn ghost file-label' }, 'Восстановить из копии',
          Object.assign(h('input', { type: 'file', accept: '.json', style: 'display:none' }) as HTMLInputElement, {
            onchange: (e: Event) => {
              const f = (e.target as HTMLInputElement).files?.[0];
              if (!f) return;
              void f.text().then(async (txt) => {
                try {
                  await api.post('/api/system/restore', JSON.parse(txt));
                  toast('success', 'Конфигурация восстановлена');
                } catch (err) { toast('error', (err as Error).message); }
              });
            }
          })),
        h('button', { class: 'btn ghost', onclick: () => void showLogs() }, 'Журнал событий'))));

    // ─── Информация ───
    const snap = await api.get<{ system: { appVersion: string; platform: string; electron: boolean; url: string; ffmpeg: boolean; startedAt: number } }>('/api/state');
    wrap.append(section('О приложении',
      h('div', { class: 'about-grid' },
        h('div', {}, 'Версия:'), h('div', {}, snap.system.appVersion),
        h('div', {}, 'Платформа:'), h('div', {}, snap.system.platform + (snap.system.electron ? ' (Electron)' : ' (веб)')),
        h('div', {}, 'Сервер:'), h('div', { class: 'addr' }, snap.system.url),
        h('div', {}, 'FFmpeg:'), h('div', {}, snap.system.ffmpeg ? 'доступен (экспорт MP3 работает)' : 'не найден (экспорт WAV работает, MP3 — нет)'),
        h('div', {}, 'Запущен:'), h('div', {}, fmtDate(snap.system.startedAt))),
      h('div', { class: 'muted note' },
        'Пользовательские данные хранятся в каталоге приложения (%APPDATA%/SonicStudio в Windows). Музыка и видео не копируются — воспроизведение идёт из исходных папок.')));
  }

  function section(title: string, ...children: HTMLElement[]): HTMLElement {
    return h('div', { class: 'card settings-card' },
      h('div', { class: 'card-title' }, title), ...children);
  }

  function folderList(folders: string[], onChange: (folders: string[]) => Promise<void>): HTMLElement {
    const box = h('div', { class: 'folder-list' });
    if (folders.length === 0) {
      box.append(h('div', { class: 'muted' }, 'Папки не добавлены'));
    }
    folders.forEach((f, i) => {
      box.append(h('div', { class: 'folder-item' },
        h('code', { class: 'folder-path' }, f),
        h('button', { class: 'icon-btn small danger', html: ICONS.trash, onclick: async () => {
          const ok = await confirmDialog('Удалить папку', `Убрать папку из библиотеки? Файлы на диске не пострадают.\n${f}`, 'Убрать');
          if (!ok) return;
          const next = folders.filter((_, idx) => idx !== i);
          await onChange(next);
        } })));
    });
    return box;
  }

  async function addFolder(folders: string[], save: (folders: string[]) => Promise<void>): Promise<void> {
    const w = window as unknown as { sonicDesktop?: { pickFolder(): Promise<string | null> } };
    if (!w.sonicDesktop) return;
    const folder = await w.sonicDesktop.pickFolder();
    if (!folder) return;
    if (folders.includes(folder)) { toast('info', 'Папка уже добавлена'); return; }
    await save([...folders, folder]);
  }

  function rangeInput(label: string, value: number, min = 0, max = MAX_FADE_SECONDS, step = 0.5, fmt: (v: number) => string = v => v.toFixed(1) + ' с') {
    const out = h('span', { class: 'range-value' }, fmt(value));
    const input = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value) }) as HTMLInputElement;
    input.addEventListener('input', () => { out.textContent = fmt(Number(input.value)); });
    return {
      get value(): number { return Number(input.value); },
      row: h('div', { class: 'form-row' }, h('label', { class: 'form-label' }, label), h('div', { class: 'range-wrap' }, input, out))
    };
  }

  async function showLogs(): Promise<void> {
    try {
      const r = await api.get<{ logs: string }>('/api/system/logs?lines=300');
      const { modal } = await import('../ui');
      modal('Журнал событий (последние 300 строк)', (body, close) => {
        const pre = h('pre', { class: 'logs-view' }, r.logs || 'Журнал пуст');
        body.append(pre, h('div', { class: 'btn-row end' },
          h('button', { class: 'btn ghost', onclick: close }, 'Закрыть')));
      }, { wide: true });
    } catch (e) {
      toast('error', (e as Error).message);
    }
  }

  const off = snapshotListener(() => { /* настройки перезагружаются вручную */ });
  void render();
  void el;
  return { teardown: off };
}
