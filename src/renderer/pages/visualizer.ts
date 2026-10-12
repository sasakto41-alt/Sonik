import { h, clear, emptyState, toast } from '../ui';
import { icon } from '../icons';
import { isElectron } from '../api';
import { player } from '../player';
import { localPref, setLocalPref } from '../store';

/**
 * Визуализация музыки на реальном сигнале через AnalyserNode:
 * столбцы, волна, круг, компактный спектр, полный экран.
 * Визуализация доступна в desktop-приложении (там звучит аудио).
 */
export function mountVisualizer(container: HTMLElement): { teardown: () => void } {
  clear(container);
  let mode = localPref('viz.mode', 'bars');
  let enabled = localPref('viz.enabled', '1') === '1';
  let raf = 0;
  let running = true;

  const modes: Array<[string, string]> = [
    ['bars', 'Частотные столбцы'],
    ['wave', 'Волновая форма'],
    ['circle', 'Круговая'],
    ['compact', 'Компактный спектр']
  ];

  const canvas = h('canvas', { class: 'viz-canvas' }) as HTMLCanvasElement;
  const box = h('div', { class: 'viz-box' + (enabled ? '' : ' off') }, canvas);

  const head = h('div', { class: 'page-head' },
    h('h2', { class: 'page-title' }, 'Визуализация'),
    h('div', { class: 'btn-row' },
      ...modes.map(([id, label]) => h('button', { class: 'btn ghost small' + (mode === id ? ' active' : ''),
        onclick: () => { mode = id; setLocalPref('viz.mode', id); renderModes(); drawFrame(true); } }, label)),
      h('button', { class: 'btn' + (enabled ? ' accent' : ''), onclick: () => {
        enabled = !enabled;
        setLocalPref('viz.enabled', enabled ? '1' : '0');
        box.classList.toggle('off', !enabled);
        if (enabled) startLoop(); else stopLoop();
      } }, enabled ? 'Визуализация включена' : 'Отключена (экономия ресурсов)'),
      h('button', { class: 'btn', html: icon('fullscreen') + '<span>Полный экран</span>', onclick: () => {
        if (document.fullscreenElement) void document.exitFullscreen();
        else void box.requestFullscreen().catch(() => toast('error', 'Не удалось включить полноэкранный режим'));
      } })));
  const modesRow = head.querySelector('.btn-row') as HTMLElement;
  function renderModes(): void {
    modesRow.querySelectorAll('button').forEach((b, i) => {
      if (i < modes.length) b.classList.toggle('active', modes[i][0] === mode);
    });
  }

  container.append(head, box);

  const hint = !isElectron()
    ? emptyState(icon('visualizer'), 'Визуализация на этом устройстве недоступна',
      'Аудио воспроизводится на компьютере. Откройте визуализацию в приложении Sonic Studio на ПК.')
    : null;
  if (hint) box.append(hint);

  function startLoop(): void {
    stopLoop();
    const loop = (): void => {
      if (!running) return;
      drawFrame();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
  }
  function stopLoop(): void {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  let freqData: Uint8Array | null = null;
  let timeData: Uint8Array | null = null;

  function drawFrame(force = false): void {
    if (!enabled && !force) return;
    const dpr = window.devicePixelRatio || 1;
    const w = box.clientWidth || 640;
    const hgt = box.clientHeight || 360;
    if (canvas.width !== w * dpr || canvas.height !== hgt * dpr) {
      canvas.width = w * dpr;
      canvas.height = hgt * dpr;
    }
    const g = canvas.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, hgt);

    const analyser = player.getAnalyser();
    if (!analyser) {
      g.fillStyle = 'rgba(232,234,240,0.4)';
      g.font = '15px system-ui';
      g.textAlign = 'center';
      g.fillText('Включите воспроизведение музыки — визуализация реагирует на реальный сигнал', w / 2, hgt / 2);
      return;
    }
    const bins = analyser.frequencyBinCount;
    if (!freqData || freqData.length !== bins || !timeData) {
      freqData = new Uint8Array(bins);
      timeData = new Uint8Array(analyser.fftSize);
    }
    const fd = freqData;
    const td = timeData;
    analyser.getByteFrequencyData(fd);
    analyser.getByteTimeDomainData(td);

    if (mode === 'bars' || mode === 'compact') {
      const count = mode === 'compact' ? 32 : 64;
      const step = Math.floor(bins / count / 2) || 1;
      const gap = mode === 'compact' ? 3 : 6;
      const bw = (w - gap * (count - 1)) / count;
      for (let i = 0; i < count; i++) {
        let sum = 0;
        for (let j = 0; j < step; j++) sum += fd[i * step + j] || 0;
        const v = sum / step / 255;
        const bh = Math.max(2, v * (hgt - 20));
        const x = i * (bw + gap);
        const grad = g.createLinearGradient(0, hgt - bh, 0, hgt);
        grad.addColorStop(0, '#22d3ee');
        grad.addColorStop(1, '#7c6cff');
        g.fillStyle = grad;
        g.beginPath();
        g.roundRect(x, hgt - bh, bw, bh, 4);
        g.fill();
      }
    } else if (mode === 'wave') {
      g.strokeStyle = '#7c6cff';
      g.lineWidth = 2.5;
      g.beginPath();
      const n = td.length;
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * w;
        const y = (td[i] / 255) * hgt;
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke();
    } else if (mode === 'circle') {
      const cx = w / 2, cy = hgt / 2;
      const baseR = Math.min(w, hgt) * 0.22;
      const count = 72;
      const step = Math.floor(bins / count) || 1;
      for (let i = 0; i < count; i++) {
        let sum = 0;
        for (let j = 0; j < step; j++) sum += fd[i * step + j] || 0;
        const v = sum / step / 255;
        const angle = (i / count) * Math.PI * 2 - Math.PI / 2;
        const r1 = baseR;
        const r2 = baseR + v * Math.min(w, hgt) * 0.32;
        g.strokeStyle = `hsl(${250 + v * 40}, 85%, ${45 + v * 25}%)`;
        g.lineWidth = 3;
        g.beginPath();
        g.moveTo(cx + Math.cos(angle) * r1, cy + Math.sin(angle) * r1);
        g.lineTo(cx + Math.cos(angle) * r2, cy + Math.sin(angle) * r2);
        g.stroke();
      }
      g.fillStyle = 'rgba(124,108,255,0.15)';
      g.beginPath();
      g.arc(cx, cy, baseR * 0.86, 0, Math.PI * 2);
      g.fill();
    }
  }

  const onResize = (): void => drawFrame(true);
  window.addEventListener('resize', onResize);
  document.addEventListener('fullscreenchange', onResize);
  startLoop();

  return {
    teardown: () => {
      running = false;
      stopLoop();
      window.removeEventListener('resize', onResize);
      document.removeEventListener('fullscreenchange', onResize);
    }
  };
}
