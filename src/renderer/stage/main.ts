import { VideoItem } from '../../shared/types';
import { api, mediaUrl, deviceId, isElectron } from '../api';

/**
 * Окно сценического вывода (Stage Output).
 * Только контент для зрителей: видео, заставка, титры, чёрный экран.
 * Никакого интерфейса управления.
 *
 * Реализует настоящие визуальные переходы:
 *  - Fade In — плавное появление из чёрного (opacity + громкость);
 *  - Fade Out — плавное исчезновение в чёрный;
 *  - Crossfade — два видео-элемента, одновременное декодирование двух источников.
 */

const videoA = document.getElementById('stage-video-a') as HTMLVideoElement;
const videoB = document.getElementById('stage-video-b') as HTMLVideoElement;
const imageLayer = document.getElementById('stage-image') as HTMLElement;
const splashLayer = document.getElementById('stage-splash') as HTMLElement;
const splashText = document.getElementById('splash-text') as HTMLElement;
const textLayer = document.getElementById('stage-text') as HTMLElement;
const blackLayer = document.getElementById('stage-black') as HTMLElement;
const tapLayer = document.getElementById('stage-tap') as HTMLButtonElement;
const exitChip = document.getElementById('stage-exit') as HTMLAnchorElement;

let currentItem: VideoItem | null = null;
let activeEl: HTMLVideoElement = videoA;
let standbyEl: HTMLVideoElement = videoB;
let fadeRaf = 0;
let fadeActive = false;
let wasPlayingBeforeBlack = false;
let blacked = false;
let splashVisible = true;
let reportTimer = 0;
let endHandled = false;
let ws: WebSocket | null = null;
let pendingPlay: HTMLVideoElement | null = null;
let settings = {
  crossfadeDuration: 2,
  splashEnabled: true,
  splashText: 'Sonic Studio'
};

// ─── Автозапуск в браузерах (телефон/планшет): если браузер запретил — просим нажатие ───

function showTapLayer(el: HTMLVideoElement): void {
  pendingPlay = el;
  tapLayer.classList.remove('hidden');
}

tapLayer.addEventListener('click', () => {
  tapLayer.classList.add('hidden');
  const el = pendingPlay;
  pendingPlay = null;
  if (el) void el.play().catch(() => showTapLayer(el));
});

/** Запуск воспроизведения с обработкой запрета автозапуска (мобильные браузеры). */
async function ensurePlay(el: HTMLVideoElement): Promise<boolean> {
  try {
    await el.play();
    return true;
  } catch {
    showTapLayer(el);
    return false;
  }
}

// ─── WebSocket ───

function connect(): void {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const token = new URLSearchParams(location.search).get('token') || localStorage.getItem('sonic.token') || '';
  const params = new URLSearchParams();
  params.set('role', 'stage');
  if (token) params.set('token', token);
  params.set('device', deviceId());
  ws = new WebSocket(`${proto}://${location.host}/ws?${params.toString()}`);
  ws.onopen = () => {
    void loadSettings();
  };
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(String(ev.data));
      if (msg.type === 'command' && (msg.target === 'stage' || msg.target === 'all')) {
        void handleCommand(msg.action, msg.payload || {});
      }
    } catch { /* ignore */ }
  };
  ws.onclose = () => {
    window.setTimeout(connect, 1500);
  };
  ws.onerror = () => { try { ws?.close(); } catch { /* ignore */ } };
}

async function loadSettings(): Promise<void> {
  try {
    const r = await api.get<{ settings: { crossfade: { enabled: boolean; duration: number }; splash: { enabled: boolean; text: string } } }>('/api/settings');
    settings.crossfadeDuration = r.settings.crossfade.duration;
    settings.splashEnabled = r.settings.splash.enabled;
    settings.splashText = r.settings.splash.text || 'Sonic Studio';
    splashText.textContent = settings.splashText;
    if (splashVisible) splashLayer.style.opacity = settings.splashEnabled ? '1' : '0';
  } catch { /* ignore */ }
}

// ─── Отчёты о состоянии ───

function send(msg: Record<string, unknown>): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'report', domain: 'stage', data: msg }));
}

function startReporting(): void {
  if (reportTimer) return;
  reportTimer = window.setInterval(() => {
    send({
      status: activeEl.paused ? (activeEl.currentTime > 0 ? 'paused' : blacked ? 'stopped' : 'idle') : 'playing',
      position: activeEl.currentTime,
      duration: activeEl.duration || 0,
      blacked,
      activeFade: fadeActive ? (fadeDirection) : null
    });
  }, 500);
}
let fadeDirection: 'in' | 'out' = 'in';

// ─── Fade-движок ───

function cancelFade(setFinal = true): void {
  if (fadeRaf) cancelAnimationFrame(fadeRaf);
  fadeRaf = 0;
  fadeActive = false;
  if (setFinal) {
    fadeDirection = 'in';
  }
  send({ activeFade: null });
}

/** Плавный ramp двух параметров: opacity элемента и громкость. */
function ramp(el: HTMLVideoElement, fromOp: number, toOp: number, fromVol: number, toVol: number, durSec: number, onDone?: () => void): void {
  cancelFade(false);
  fadeActive = true;
  const start = performance.now();
  const dur = Math.max(50, durSec * 1000);
  const tick = (now: number): void => {
    if (!fadeActive) return;
    const k = Math.min(1, (now - start) / dur);
    const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; // easeInOutQuad
    el.style.opacity = String(fromOp + (toOp - fromOp) * e);
    if (!el.muted) el.volume = Math.max(0, Math.min(1, fromVol + (toVol - fromVol) * e));
    if (k < 1) {
      fadeRaf = requestAnimationFrame(tick);
    } else {
      fadeActive = false;
      fadeRaf = 0;
      send({ activeFade: null });
      onDone?.();
    }
  };
  fadeRaf = requestAnimationFrame(tick);
}

function applyInstant(el: HTMLVideoElement, op: number): void {
  el.style.transition = 'none';
  el.style.opacity = String(op);
}

// ─── Управление ───

interface LoadPayload {
  videoId: string;
  autoplay?: boolean;
  item?: Partial<VideoItem>;
  volume?: number;
  muted?: boolean;
}

async function handleCommand(action: string, payload: Record<string, unknown>): Promise<void> {
  switch (action) {
    case 'load': {
      const p = payload as unknown as LoadPayload;
      endHandled = false;
      currentItem = { ...(currentItem || ({} as VideoItem)), ...p.item, id: p.videoId } as VideoItem;
      const src = mediaUrl(`/api/media/video/${p.videoId}`);
      blacked = false;
      blackLayer.style.opacity = '0';
      showSplash(false);
      // Готовим активный элемент
      activeEl.src = src;
      activeEl.volume = currentItem.muted ? 0 : (currentItem.volume ?? 1);
      activeEl.muted = Boolean(currentItem.muted);
      applyInstant(activeEl, 0);
      standbyEl.style.opacity = '0';
      imageLayer.classList.add('hidden');
      try {
        await activeEl.play();
        // Начальная позиция
        if (currentItem.startPosition) activeEl.currentTime = currentItem.startPosition;
        startReporting();
        if (currentItem.fadeIn > 0) {
          // Fade In: из чёрного + плавная громкость
          fadeDirection = 'in';
          send({ activeFade: 'in' });
          activeEl.volume = activeEl.muted ? 0 : 0;
          ramp(activeEl, 0, 1, 0, activeEl.muted ? 0 : (currentItem.volume ?? 1), currentItem.fadeIn);
        } else {
          applyInstant(activeEl, 1);
        }
        send({ status: 'playing', duration: activeEl.duration || 0 });
      } catch {
        // Браузер запретил автозапуск — покажем «Нажмите, чтобы включить показ»
        showTapLayer(activeEl);
        send({ status: 'paused' });
      }
      break;
    }
    case 'play': {
      blacked = false;
      blackLayer.style.opacity = '0';
      showSplash(false);
      const started = await ensurePlay(activeEl);
      if (started) {
        if (currentItem && currentItem.fadeIn > 0 && activeEl.currentTime <= (currentItem.startPosition || 0) + 0.2) {
          fadeDirection = 'in';
          send({ activeFade: 'in' });
          ramp(activeEl, 0, 1, 0, activeEl.muted ? 0 : (currentItem.volume ?? 1), currentItem.fadeIn);
        } else {
          applyInstant(activeEl, 1);
        }
      }
      break;
    }
    case 'pause':
      activeEl.pause();
      break;
    case 'resume':
      void ensurePlay(activeEl);
      break;
    case 'stopNow': {
      // Мгновенная остановка и безопасный чёрный экран
      cancelFade();
      activeEl.pause();
      blacked = true;
      blackLayer.style.opacity = '1';
      applyInstant(activeEl, 0);
      activeEl.currentTime = currentItem?.startPosition || 0;
      send({ status: 'stopped', blacked: true });
      break;
    }
    case 'fadeOutThenBlack': {
      const dur = Number(payload.duration) || 0;
      blacked = true;
      if (dur > 0 && !activeEl.paused) {
        fadeDirection = 'out';
        send({ activeFade: 'out' });
        ramp(activeEl, parseFloat(activeEl.style.opacity || '1'), 0,
          activeEl.muted ? 0 : activeEl.volume, 0, dur, () => {
            activeEl.pause();
            blackLayer.style.opacity = '1';
          });
      } else {
        activeEl.pause();
        blackLayer.style.opacity = '1';
        applyInstant(activeEl, 0);
      }
      break;
    }
    case 'freeze': {
      cancelFade();
      activeEl.pause();
      applyInstant(activeEl, 1);
      blackLayer.style.opacity = '0';
      break;
    }
    case 'seek': {
      const t = Number(payload.time);
      if (isFinite(t)) {
        activeEl.currentTime = t;
        endHandled = false;
      }
      break;
    }
    case 'black': {
      // Скрываем контент, не закрывая окно
      wasPlayingBeforeBlack = !activeEl.paused;
      cancelFade();
      activeEl.pause();
      blacked = true;
      blackLayer.style.opacity = '1';
      break;
    }
    case 'restore': {
      blacked = false;
      blackLayer.style.opacity = '0';
      applyInstant(activeEl, 1);
      if (wasPlayingBeforeBlack) void ensurePlay(activeEl);
      break;
    }
    case 'fadeIn': {
      const dur = Number(payload.duration) || (currentItem?.fadeIn ?? 0);
      blacked = false;
      blackLayer.style.opacity = '0';
      fadeDirection = 'in';
      send({ activeFade: 'in' });
      ramp(activeEl, parseFloat(activeEl.style.opacity || '0'), 1, activeEl.muted ? 0 : 0, activeEl.muted ? 0 : (currentItem?.volume ?? 1), dur);
      break;
    }
    case 'fadeOut': {
      const dur = Number(payload.duration) || (currentItem?.fadeOut ?? 0);
      fadeDirection = 'out';
      send({ activeFade: 'out' });
      ramp(activeEl, parseFloat(activeEl.style.opacity || '1'), 0, activeEl.muted ? 0 : activeEl.volume, 0, dur, () => {
        activeEl.pause();
        blacked = true;
        blackLayer.style.opacity = '1';
      });
      break;
    }
    case 'setVolume': {
      const v = Number(payload.volume);
      if (currentItem) currentItem.volume = v;
      if (!activeEl.muted && !fadeActive) activeEl.volume = v;
      break;
    }
    case 'setMuted': {
      const m = Boolean(payload.muted);
      if (currentItem) currentItem.muted = m;
      activeEl.muted = m;
      activeEl.volume = m ? 0 : (currentItem?.volume ?? 1);
      break;
    }
    case 'setRepeat': {
      if (currentItem) currentItem.repeat = Boolean(payload.repeat);
      break;
    }
    case 'applySettings': {
      if (currentItem) {
        Object.assign(currentItem, payload);
        if (!fadeActive) {
          activeEl.muted = Boolean(currentItem.muted);
          activeEl.volume = currentItem.muted ? 0 : (currentItem.volume ?? 1);
        }
      }
      break;
    }
    case 'crossfade': {
      const p = payload as { videoId: string; duration: number; volume: number; muted: boolean };
      await crossfadeTo(p.videoId, p.duration, p.volume, p.muted);
      break;
    }
    case 'showSplash': {
      cancelFade();
      activeEl.pause();
      applyInstant(activeEl, 0);
      showSplash(true);
      break;
    }
    case 'showImage': {
      // Картинка на весь экран (заполнить). Видео останавливается полностью.
      const imageId = String(payload.imageId || '');
      cancelFade();
      activeEl.pause();
      standbyEl.pause();
      applyInstant(activeEl, 0);
      standbyEl.style.opacity = '0';
      showSplash(false);
      textLayer.classList.add('hidden');
      if (imageId) {
        imageLayer.style.backgroundImage = `url("${mediaUrl(`/api/media/image/${imageId}`)}")`;
        imageLayer.classList.remove('hidden');
      }
      blacked = false;
      blackLayer.style.opacity = '0';
      send({ status: 'stopped', imageShown: true });
      break;
    }
    case 'hideImage': {
      // Убираем картинку — возвращаемся к безопасному чёрному экрану
      cancelFade();
      activeEl.pause();
      applyInstant(activeEl, 0);
      imageLayer.classList.add('hidden');
      blacked = true;
      blackLayer.style.opacity = '1';
      send({ status: 'stopped', imageShown: false, blacked: true });
      break;
    }
    case 'showText': {
      const text = String(payload.text || '');
      if (text) {
        textLayer.textContent = text;
        textLayer.classList.remove('hidden');
      }
      break;
    }
    case 'hideText':
      textLayer.classList.add('hidden');
      break;
  }
}

function showSplash(on: boolean): void {
  splashVisible = on;
  splashLayer.style.opacity = on && settings.splashEnabled ? '1' : '0';
}

// ─── Crossfade: два элемента = два декодера ───

async function crossfadeTo(videoId: string, dur: number, volume: number, muted: boolean): Promise<void> {
  endHandled = false;
  imageLayer.classList.add('hidden');
  const nextEl = standbyEl;
  nextEl.src = mediaUrl(`/api/media/video/${videoId}`);
  nextEl.volume = muted ? 0 : volume;
  nextEl.muted = muted;
  applyInstant(nextEl, 0);
  try {
    const ok = await ensurePlay(nextEl);
    if (!ok) return; // ждём нажатия пользователя — старт продолжится по команде play
    const prevEl = activeEl;
    activeEl = nextEl;
    standbyEl = prevEl;
    // Одновременный ramp: старое видео уходит, новое появляется
    fadeActive = true;
    const start = performance.now();
    const durMs = Math.max(200, dur * 1000);
    const tick = (now: number): void => {
      const k = Math.min(1, (now - start) / durMs);
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      activeEl.style.opacity = String(e);
      if (!activeEl.muted) activeEl.volume = volume * e;
      prevEl.style.opacity = String(1 - e);
      if (!prevEl.muted) prevEl.volume = (prevEl.volume) * (1 - e);
      if (k < 1) {
        fadeRaf = requestAnimationFrame(tick);
      } else {
        fadeActive = false;
        prevEl.pause();
        prevEl.removeAttribute('src');
        fadeDirection = 'in';
      }
    };
    fadeRaf = requestAnimationFrame(tick);
    currentItem = { ...(currentItem || ({} as VideoItem)), id: videoId, volume, muted } as VideoItem;
    startReporting();
  } catch {
    // Не смогли воспроизвести — остаёмся на текущем
  }
}

// ─── Завершение ролика ───

videoA.addEventListener('ended', onEnded);
videoB.addEventListener('ended', onEnded);
videoA.addEventListener('timeupdate', onTimeUpdate);
videoB.addEventListener('timeupdate', onTimeUpdate);

function onEnded(ev: Event): void {
  if (!currentItem) return;
  const el = ev.target === videoB ? videoB : videoA;
  // Бесшовный повтор: локальный перезапуск — без перезагрузки src,
  // без запроса на сервер и без чёрного кадра между повторами.
  if (currentItem.repeat) {
    endHandled = false;
    el.currentTime = currentItem.startPosition || 0;
    void el.play().catch(() => {});
    send({ status: 'playing', position: el.currentTime });
    return;
  }
  if (endHandled) return;
  endHandled = true;
  send({ ended: currentItem.id, status: 'stopped' });
}

function onTimeUpdate(): void {
  if (!currentItem) return;
  // Ограничение конечной позицией
  if (currentItem.endPosition && activeEl.currentTime >= currentItem.endPosition) {
    if (currentItem.repeat) {
      // Повтор с обрезкой: бесшовный возврат к начальной позиции без "ended"
      activeEl.currentTime = currentItem.startPosition || 0;
      send({ status: 'playing', position: activeEl.currentTime });
      return;
    }
    if (!endHandled) {
      endHandled = true;
      send({ ended: currentItem.id, status: 'stopped' });
    }
  }
}

// ─── Клавиатура окна сцены: Esc — выход из полного экрана, F11 — переключение ───

window.addEventListener('keydown', (e) => {
  const desktop = (window as unknown as { sonicDesktop?: { setFullscreen(on: boolean): Promise<boolean>; isFullscreen(): Promise<boolean> } }).sonicDesktop;
  if (!desktop) return;
  if (e.key === 'Escape') {
    void desktop.isFullscreen().then(fs => { if (fs) void desktop.setFullscreen(false); });
  } else if (e.key === 'F11') {
    e.preventDefault();
    void desktop.isFullscreen().then(fs => void desktop.setFullscreen(!fs));
  }
});

// Заставка по умолчанию
splashText.textContent = settings.splashText;
// Веб-устройства (телефон/планшет/ТВ): кнопка возврата к интерфейсу
if (!isElectron()) exitChip.classList.remove('hidden');
connect();
startReporting();
void api.get<{ snapshot?: unknown }>('/api/state').catch(() => {});
void videoA; void videoB;
