import { Snapshot } from '../shared/types';
import { store, localPref, setLocalPref } from './store';
import { api, setToastHandler, setAuthHandler, login, isElectron } from './api';
import { toast, modal, closeTopModal, el, h, clear } from './ui';
import { ICONS } from './icons';
import { player } from './player';
import { initPlayerBar, updateConnStatus } from './components';
import { mountHome } from './pages/home';
import { mountMusic } from './pages/music';
import { mountPlaylists } from './pages/playlists';
import { mountVideos } from './pages/videos';
import { mountSoundboard } from './pages/soundboard';
import { mountEditor } from './pages/editor';
import { mountEqualizer } from './pages/equalizer';
import { mountVisualizer } from './pages/visualizer';
import { mountStage } from './pages/stage';
import { mountSettings } from './pages/settings';
import { mountQuick } from './pages/quick';

/**
 * Bootstrap интерфейса: сайдбар, роутер, панель плеера, WS-события, хоткеи.
 */

const NAV: Array<{ id: string; label: string; icon: string; desktop?: boolean }> = [
  { id: 'home', label: 'Главная', icon: 'home' },
  { id: 'quick', label: 'Быстрый режим', icon: 'check', desktop: true },
  { id: 'music', label: 'Музыка', icon: 'music' },
  { id: 'playlists', label: 'Плейлисты', icon: 'playlist' },
  { id: 'videos', label: 'Видео', icon: 'video' },
  { id: 'soundboard', label: 'Soundboard', icon: 'soundboard' },
  { id: 'editor', label: 'Аудиоредактор', icon: 'editor' },
  { id: 'equalizer', label: 'Эквалайзер', icon: 'equalizer' },
  { id: 'visualizer', label: 'Визуализация', icon: 'visualizer' },
  { id: 'stage', label: 'Сценический вывод', icon: 'stage' },
  { id: 'settings', label: 'Настройки', icon: 'settings' }
];

type PageMount = (container: HTMLElement, params: URLSearchParams) => { teardown?: () => void } | void;

const ROUTES: Record<string, PageMount> = {
  home: mountHome,
  quick: mountQuick,
  music: mountMusic,
  playlists: mountPlaylists,
  videos: mountVideos,
  soundboard: mountSoundboard,
  editor: mountEditor,
  equalizer: mountEqualizer,
  visualizer: mountVisualizer,
  stage: mountStage,
  settings: mountSettings
};

let currentTeardown: (() => void) | null = null;
let currentPage = '';

function navigateFromHash(): void {
  const raw = location.hash.replace(/^#\/?/, '') || 'home';
  const [page, query] = raw.split('?');
  navigate(ROUTES[page] ? page : 'home', new URLSearchParams(query || ''));
}

export function navigate(page: string, params: URLSearchParams = new URLSearchParams()): void {
  if (currentTeardown) { currentTeardown(); currentTeardown = null; }
  currentPage = page;
  const hash = '#/' + page + (params.toString() ? '?' + params.toString() : '');
  if (location.hash !== hash) history.replaceState(null, '', hash);
  const container = el<HTMLElement>('#page');
  clear(container);
  const title = NAV.find(n => n.id === page)?.label || 'Sonic Studio';
  el<HTMLElement>('#topbar-title').textContent = title;
  document.querySelectorAll('#sidebar .nav-item').forEach(item => {
    item.classList.toggle('active', (item as HTMLElement).dataset.page === page);
  });
  const r = ROUTES[page](container, params);
  currentTeardown = r?.teardown || null;
  // Мобильный сайдбар закрывается после перехода
  el<HTMLElement>('#app').classList.remove('nav-open');
  window.scrollTo(0, 0);
}

function buildSidebar(): void {
  const sb = el<HTMLElement>('#sidebar');
  clear(sb);
  sb.append(
    h('div', { class: 'logo' },
      h('span', { class: 'logo-icon', html: ICONS.logo }),
      h('span', { class: 'logo-text' }, 'Sonic', h('b', {}, ' Studio')))
  );
  const nav = h('nav', { class: 'nav' });
  for (const item of NAV) {
    if (item.desktop && !isElectron()) continue; // быстрый режим — только на компьютере
    nav.append(h('button', {
      class: 'nav-item',
      'data-page': item.id,
      onclick: () => { location.hash = '#/' + item.id; navigate(item.id); }
    },
      h('span', { class: 'nav-icon', html: ICONS[item.icon] }),
      h('span', { class: 'nav-label' }, item.label)));
  }
  sb.append(nav);
  sb.append(h('div', { class: 'sidebar-foot' },
    h('div', { class: 'version-note' }, 'Sonic Studio · локальный сервер')));
}

/** Авторизация для веб-клиентов (LAN): ввод PIN-кода. */
function showLoginModal(): void {
  modal('Подключение к Sonic Studio', (body, close) => {
    body.append(h('p', { class: 'confirm-text' },
      'Введите PIN-код, отображаемый в настройках приложения на компьютере (раздел «Настройки» → «Сервер и доступ»).'));
    const input = h('input', { class: 'input', type: 'text', inputmode: 'numeric', placeholder: 'PIN-код', maxlength: '6' }) as HTMLInputElement;
    const err = h('div', { class: 'form-error hidden' }) as HTMLElement;
    const btn = h('button', { class: 'btn accent full' }, 'Подключиться');
    const submit = async () => {
      try {
        await login(input.value.trim());
        err.classList.add('hidden');
        close();
        toast('success', 'Подключено к Sonic Studio');
        location.reload();
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

function applySnapshot(s: Snapshot): void {
  updateConnStatus(true, s.system.electron);
  player.applySnapshot(s);
  document.querySelectorAll('#sidebar .nav-item').forEach(() => { /* подсветка обновляется в navigate */ });
}

function bindStore(): void {
  store.on(e => {
    if (e.type === 'snapshot') applySnapshot(e.snapshot);
    else if (e.type === 'connected') { updateConnStatus(true, store.snapshot?.system.electron ?? isElectron()); }
    else if (e.type === 'disconnected') updateConnStatus(false, false);
    else if (e.type === 'auth') showLoginModal();
    else if (e.type === 'command') {
      if (e.target === 'toast') {
        toast((e.action as 'info' | 'success' | 'error') || 'info', String(e.payload || ''));
        return;
      }
      // Команды сервера: музыкальному плееру — desktop; эквалайзеру — все; soundboard — все
      if (e.target === 'renderer' && e.domain === 'player' && isElectron()) {
        void player.command(e.action, (e.payload as Record<string, unknown>) || {});
      } else if (e.target === 'renderer' && e.domain === 'eq') {
        player.applyEq(e.payload as never);
        document.dispatchEvent(new CustomEvent('sonic:eq', { detail: e.payload }));
      } else if (e.target === 'all' && e.domain === 'soundboard') {
        document.dispatchEvent(new CustomEvent('sonic:soundboard', { detail: { action: e.action, payload: e.payload } }));
      }
      // target=stage обрабатывается страницей сцены (stage/main.ts)
    }
  });
}

/** Горячие клавиши основного окна. */
function bindHotkeys(): void {
  window.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement;
    const inField = target && (
      target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' ||
      target.tagName === 'SELECT' || target.isContentEditable);
    if (e.key === 'Escape') {
      if (closeTopModal()) { e.preventDefault(); return; }
      if (document.fullscreenElement) { void document.exitFullscreen().catch(() => {}); e.preventDefault(); return; }
      const appRoot = document.getElementById('app');
      if (appRoot?.classList.contains('nav-open')) { appRoot.classList.remove('nav-open'); e.preventDefault(); }
      return;
    }
    if (inField) return;
    if (e.code === 'Space') {
      e.preventDefault();
      if (isElectron()) void player.toggle();
      else void player.remoteCommand('toggle');
    } else if (e.ctrlKey && e.code === 'ArrowRight') {
      e.preventDefault();
      if (isElectron()) void player.next();
      else void player.remoteCommand('next');
    } else if (e.ctrlKey && e.code === 'ArrowLeft') {
      e.preventDefault();
      if (isElectron()) void player.prev();
      else void player.remoteCommand('prev');
    } else if (e.ctrlKey && e.code === 'ArrowUp') {
      e.preventDefault();
      const v = Math.min(1, player.state.volume + 0.05);
      if (isElectron()) player.setVolume(v); else void player.remoteCommand('setVolume', { volume: v });
    } else if (e.ctrlKey && e.code === 'ArrowDown') {
      e.preventDefault();
      const v = Math.max(0, player.state.volume - 0.05);
      if (isElectron()) player.setVolume(v); else void player.remoteCommand('setVolume', { volume: v });
    }
  });
}

async function boot(): Promise<void> {
  buildSidebar();
  initPlayerBar();
  bindStore();
  bindHotkeys();

  setToastHandler((level, msg) => toast(level, msg));
  setAuthHandler(() => store.emit({ type: 'auth' }));

  // Инициализация громкости из сохранённых настроек
  try {
    const s = await api.get<Snapshot>('/api/state');
    store.applySnapshot(s);
    player.state.volume = s.player.volume;
    player.state.muted = s.player.muted;
    player.applyEq(s.eq);
  } catch {
    /* 401 → модалка логина, остальное — статус отключено */
  }

  player.startReporting();
  store.connect();

  window.addEventListener('hashchange', navigateFromHash);
  navigateFromHash();

  // Автогенерация миниатюр видео (desktop и веб) — фоновый воркер
  void import('./pages/videos').then(m => m.startThumbWorker());
}

void boot();
export { setLocalPref, localPref };
