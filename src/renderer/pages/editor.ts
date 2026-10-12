import { h, clear, el, emptyState, spinner, toast, promptDialog, confirmDialog, modal } from '../ui';
import { ICONS, icon } from '../icons';
import { api, mediaUrl, isElectron } from '../api';
import { Track, EQ_BANDS, MAX_FADE_SECONDS } from '../../shared/types';
import { snapshotListener } from '../components';
import { EQ_PRESETS } from '../../shared/types';

/**
 * Аудиоредактор: волна, выделение, обрезка, громкость, Fade In/Out,
 * прослушивание, экспорт WAV/MP3, сохранение в Soundboard.
 */
export function mountEditor(container: HTMLElement): { teardown: () => void } {
  clear(container);
  const wrap = h('div', { class: 'editor-wrap' });
  container.append(wrap);

  let buffer: AudioBuffer | null = null;
  let sourceName = '';
  let sourcePath = '';
  let selStart = 0;
  let selEnd = 0;
  let playing = false;
  let playNode: AudioBufferSourceNode | null = null;
  let playGain: GainNode | null = null;
  let ctx: AudioContext | null = null;
  let gainVal = 1;
  let fadeIn = 0;
  let fadeOut = 0;
  let raf = 0;

  // UI
  const head = h('div', { class: 'page-head' },
    h('h2', { class: 'page-title' }, 'Аудиоредактор'),
    h('div', { class: 'btn-row' },
      h('select', { class: 'input select', id: 'ed-source' } as never) as HTMLSelectElement,
      isElectron() ? h('button', { class: 'btn', html: icon('folder') + '<span>Открыть файл</span>', onclick: () => void openFileDialog() }) : h('span'),
      h('label', { class: 'btn ghost file-label' }, 'Открыть локально',
        Object.assign(h('input', { type: 'file', accept: 'audio/*', style: 'display:none' }) as HTMLInputElement, {
          onchange: (e: Event) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) void loadLocalFile(f); }
        }))));
  const canvasBox = h('div', { class: 'wave-box' });
  const canvas = h('canvas', { class: 'wave-canvas' }) as HTMLCanvasElement;
  const selLayer = h('div', { class: 'wave-selection hidden' });
  canvasBox.append(canvas, selLayer);

  const info = h('div', { class: 'editor-info' }, 'Загрузите аудиофайл для начала работы.');
  const controls = h('div', { class: 'editor-controls' });

  wrap.append(head, canvasBox, info, controls);

  async function refreshSources(): Promise<void> {
    const sel = el<HTMLSelectElement>('#ed-source', wrap);
    const tracks = (await api.get<{ tracks: Track[] }>('/api/music/tracks')).tracks;
    clear(sel);
    sel.append(h('option', { value: '' }, '— Выберите трек из библиотеки —'));
    for (const t of tracks) {
      sel.append(h('option', { value: t.id }, `${t.title} — ${t.artist}`));
    }
    sel.addEventListener('change', async () => {
      if (!sel.value) return;
      const t = tracks.find(x => x.id === sel.value);
      if (!t) return;
      await loadFromUrl(mediaUrl(`/api/media/audio/${t.id}`), t.title, t.path);
    });
  }

  async function openFileDialog(): Promise<void> {
    const w = window as unknown as { sonicDesktop?: { pickFiles(k: string): Promise<string[]> } };
    if (!w.sonicDesktop) return;
    const files = await w.sonicDesktop.pickFiles('any');
    if (!files || files.length === 0) return;
    const p = files[0];
    await loadFromUrl(mediaUrl(`/api/media/file?path=${encodeURIComponent(p)}`), p.split(/[\\/]/).pop() || 'файл', p);
  }

  async function loadLocalFile(file: File): Promise<void> {
    sourceName = file.name.replace(/\.[^.]+$/, '');
    sourcePath = '';
    const arr = await file.arrayBuffer();
    await decode(arr);
  }

  async function loadFromUrl(url: string, name: string, path: string): Promise<void> {
    try {
      info.textContent = 'Загрузка и декодирование…';
      const res = await fetch(url);
      if (!res.ok) throw new Error('Не удалось загрузить файл. Возможно, формат не поддерживается.');
      const arr = await res.arrayBuffer();
      sourceName = name.replace(/\.[^.]+$/, '');
      sourcePath = path;
      await decode(arr);
    } catch (e) {
      info.textContent = '';
      toast('error', (e as Error).message);
    }
  }

  async function decode(arr: ArrayBuffer): Promise<void> {
    try {
      ctx = ctx || new AudioContext();
      buffer = await ctx.decodeAudioData(arr);
      selStart = 0;
      selEnd = buffer.duration;
      gainVal = 1;
      fadeIn = 0;
      fadeOut = 0;
      drawWave();
      buildControls();
      info.textContent = `Длительность: ${buffer.duration.toFixed(1)} с · каналы: ${buffer.numberOfChannels} · частота: ${buffer.sampleRate} Гц`;
    } catch (e) {
      toast('error', 'Не удалось декодировать аудио: ' + (e as Error).message);
      info.textContent = '';
    }
  }

  function drawWave(): void {
    if (!buffer) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvasBox.clientWidth || 800;
    const hgt = 180;
    canvas.width = w * dpr;
    canvas.height = hgt * dpr;
    canvas.style.width = w + 'px';
    canvas.style.height = hgt + 'px';
    const g = canvas.getContext('2d')!;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, hgt);
    // Сетка
    g.strokeStyle = 'rgba(255,255,255,0.06)';
    g.beginPath();
    g.moveTo(0, hgt / 2);
    g.lineTo(w, hgt / 2);
    g.stroke();
    // Пики
    const data = buffer.getChannelData(0);
    const step = Math.max(1, Math.floor(data.length / w));
    const grad = g.createLinearGradient(0, 0, 0, hgt);
    grad.addColorStop(0, '#9485ff');
    grad.addColorStop(0.5, '#7c6cff');
    grad.addColorStop(1, '#22d3ee');
    g.fillStyle = grad;
    for (let x = 0; x < w; x++) {
      let min = 1, max = -1;
      const start = x * step;
      for (let i = 0; i < step; i += 8) {
        const v = data[start + i] || 0;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      const y1 = (1 - max) * hgt / 2;
      const y2 = (1 - min) * hgt / 2;
      g.fillRect(x, y1, 1, Math.max(1, y2 - y1));
    }
    updateSel();
  }

  function updateSel(): void {
    if (!buffer) return;
    const w = canvasBox.clientWidth || 800;
    const k = w / buffer.duration;
    selLayer.classList.remove('hidden');
    selLayer.style.left = (selStart * k) + 'px';
    selLayer.style.width = Math.max(2, (selEnd - selStart) * k) + 'px';
  }

  // Выделение перетаскиванием по волне
  let dragging = false;
  let anchor = 0;
  canvas.addEventListener('pointerdown', (e) => {
    if (!buffer) return;
    dragging = true;
    canvas.setPointerCapture(e.pointerId);
    const rect = canvas.getBoundingClientRect();
    anchor = Math.max(0, Math.min(buffer.duration, (e.clientX - rect.left) / rect.width * buffer.duration));
    selStart = anchor;
    selEnd = anchor;
    updateSel();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging || !buffer) return;
    const rect = canvas.getBoundingClientRect();
    const t = Math.max(0, Math.min(buffer.duration, (e.clientX - rect.left) / rect.width * buffer.duration));
    selStart = Math.min(anchor, t);
    selEnd = Math.max(anchor, t);
    updateSel();
    updateInfoRow();
  });
  canvas.addEventListener('pointerup', () => { dragging = false; updateInfoRow(); });

  function buildControls(): void {
    clear(controls);
    if (!buffer) return;
    const timeRow = h('div', { class: 'editor-info' });
    const updateInfoRow = () => {
      timeRow.textContent = `Выделение: ${selStart.toFixed(2)} с — ${selEnd.toFixed(2)} с (${(selEnd - selStart).toFixed(2)} с)`;
    };
    window.__updateInfo = updateInfoRow;
    updateInfoRow();

    const playSel = h('button', { class: 'btn accent', html: ICONS.play + '<span>Играть выделение</span>', onclick: () => void playSelection() });
    const playAll = h('button', { class: 'btn', html: ICONS.play + '<span>Играть всё</span>', onclick: () => { selStart = 0; selEnd = buffer!.duration; void playSelection(); } });
    const stopBtn = h('button', { class: 'btn ghost', html: ICONS.stop + '<span>Стоп</span>', onclick: stopPlay });
    const selectAll = h('button', { class: 'btn ghost', onclick: () => { selStart = 0; selEnd = buffer!.duration; updateSel(); updateInfoRow(); } }, 'Выделить всё');
    const trimBtn = h('button', { class: 'btn', html: icon('editor') + '<span>Обрезать по выделению</span>', onclick: () => void trim() });

    // Громкость и фейды
    const gainInput = h('input', { type: 'range', min: '0', max: '3', step: '0.05', value: String(gainVal) }) as HTMLInputElement;
    const gainLabel = h('span', { class: 'range-value' }, Math.round(gainVal * 100) + '%');
    gainInput.addEventListener('input', () => { gainVal = Number(gainInput.value); gainLabel.textContent = Math.round(gainVal * 100) + '%'; if (playGain) playGain.gain.value = gainVal; });
    const fadeInInput = h('input', { type: 'range', min: '0', max: String(MAX_FADE_SECONDS), step: '0.5', value: String(fadeIn) }) as HTMLInputElement;
    const fadeInLabel = h('span', { class: 'range-value' }, fadeIn.toFixed(1) + ' с');
    fadeInInput.addEventListener('input', () => { fadeIn = Number(fadeInInput.value); fadeInLabel.textContent = fadeIn.toFixed(1) + ' с'; });
    const fadeOutInput = h('input', { type: 'range', min: '0', max: String(MAX_FADE_SECONDS), step: '0.5', value: String(fadeOut) }) as HTMLInputElement;
    const fadeOutLabel = h('span', { class: 'range-value' }, fadeOut.toFixed(1) + ' с');
    fadeOutInput.addEventListener('input', () => { fadeOut = Number(fadeOutInput.value); fadeOutLabel.textContent = fadeOut.toFixed(1) + ' с'; });

    const nameInput = h('input', { class: 'input', value: sourceName + ' (edited)', placeholder: 'Имя файла' }) as HTMLInputElement;

    const exportWav = h('button', { class: 'btn accent', html: icon('download') + '<span>Экспорт WAV</span>', onclick: () => void doExport('wav') });
    const exportMp3 = h('button', { class: 'btn', html: icon('download') + '<span>Экспорт MP3</span>', onclick: () => void doExport('mp3') });
    const toSb = h('button', { class: 'btn', html: icon('soundboard') + '<span>В Soundboard</span>', onclick: () => void doExport('soundboard') });

    controls.append(
      h('div', { class: 'editor-actions' }, playSel, playAll, stopBtn, selectAll, trimBtn),
      h('div', { class: 'form-grid' },
        h('div', { class: 'form-row' }, h('label', { class: 'form-label' }, 'Громкость'), h('div', { class: 'range-wrap' }, gainInput, gainLabel)),
        h('div', { class: 'form-row' }, h('label', { class: 'form-label' }, 'Fade In начала'), h('div', { class: 'range-wrap' }, fadeInInput, fadeInLabel)),
        h('div', { class: 'form-row' }, h('label', { class: 'form-label' }, 'Fade Out конца'), h('div', { class: 'range-wrap' }, fadeOutInput, fadeOutLabel))),
      timeRow,
      h('div', { class: 'form-row' }, h('label', { class: 'form-label' }, 'Имя результата'), nameInput),
      h('div', { class: 'editor-actions' }, exportWav, exportMp3, toSb));
    void updateInfoRow;
  }

  async function playSelection(): Promise<void> {
    if (!buffer || !ctx) return;
    stopPlay();
    ctx = ctx || new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = gainVal;
    const start = selStart;
    const dur = Math.max(0.05, selEnd - selStart);
    // Фейды при прослушивании
    if (fadeIn > 0) {
      gain.gain.setValueAtTime(0, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(gainVal, ctx.currentTime + Math.min(fadeIn, dur / 2));
    }
    if (fadeOut > 0) {
      const fo = Math.min(fadeOut, dur / 2);
      gain.gain.setValueAtTime(gainVal, ctx.currentTime + dur - fo);
      gain.gain.linearRampToValueAtTime(0, ctx.currentTime + dur);
    }
    src.connect(gain).connect(ctx.destination);
    src.start(0, start, dur);
    playNode = src;
    playGain = gain;
    playing = true;
    src.onended = () => { playing = false; playNode = null; };
  }

  function stopPlay(): void {
    if (playNode) { try { playNode.stop(); } catch { /* ignore */ } playNode = null; }
    playing = false;
  }

  function trim(): void {
    if (!buffer || !ctx) return;
    const startS = Math.floor(selStart * buffer.sampleRate);
    const lenS = Math.floor((selEnd - selStart) * buffer.sampleRate);
    if (lenS < 100) { toast('error', 'Выделение слишком короткое'); return; }
    const newBuf = ctx.createBuffer(buffer.numberOfChannels, lenS, buffer.sampleRate);
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      newBuf.getChannelData(ch).set(buffer.getChannelData(ch).subarray(startS, startS + lenS));
    }
    buffer = newBuf;
    selStart = 0;
    selEnd = buffer.duration;
    drawWave();
    buildControls();
    info.textContent = `Обрезано. Новая длительность: ${buffer.duration.toFixed(1)} с. Оригинал не изменён — экспортируйте результат.`;
    toast('success', 'Обрезано по выделению (в памяти)');
  }

  /** Рендер результатного буфера с громкостью и фейдами. */
  function renderResult(): AudioBuffer | null {
    if (!buffer || !ctx) return null;
    const out = ctx.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const src = buffer.getChannelData(ch);
      const dst = out.getChannelData(ch);
      const fi = Math.min(fadeIn * buffer.sampleRate, buffer.length / 2);
      const fo = Math.min(fadeOut * buffer.sampleRate, buffer.length / 2);
      for (let i = 0; i < src.length; i++) {
        let k = gainVal;
        if (fi > 0 && i < fi) k *= i / fi;
        if (fo > 0 && i > src.length - fo) k *= (src.length - i) / fo;
        dst[i] = Math.max(-1, Math.min(1, src[i] * k));
      }
    }
    return out;
  }

  function encodeWav(buf: AudioBuffer): Blob {
    const numCh = buf.numberOfChannels;
    const len = buf.length;
    const bytes = len * numCh * 2;
    const ab = new ArrayBuffer(44 + bytes);
    const view = new DataView(ab);
    const wstr = (off: number, s: string): void => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
    wstr(0, 'RIFF');
    view.setUint32(4, 36 + bytes, true);
    wstr(8, 'WAVE');
    wstr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numCh, true);
    view.setUint32(24, buf.sampleRate, true);
    view.setUint32(28, buf.sampleRate * numCh * 2, true);
    view.setUint16(32, numCh * 2, true);
    view.setUint16(34, 16, true);
    wstr(36, 'data');
    view.setUint32(40, bytes, true);
    const chans: Float32Array[] = [];
    for (let ch = 0; ch < numCh; ch++) chans.push(buf.getChannelData(ch));
    let off = 44;
    for (let i = 0; i < len; i++) {
      for (let ch = 0; ch < numCh; ch++) {
        const v = Math.max(-1, Math.min(1, chans[ch][i]));
        view.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7FFF, true);
        off += 2;
      }
    }
    return new Blob([ab], { type: 'audio/wav' });
  }

  async function doExport(kind: 'wav' | 'mp3' | 'soundboard'): Promise<void> {
    if (!buffer) { toast('info', 'Сначала загрузите аудио'); return; }
    const name = (controls.querySelector('input.input') as HTMLInputElement)?.value?.trim() || 'export';
    const result = renderResult();
    if (!result) return;
    const wav = encodeWav(result);

    if (kind === 'soundboard') {
      try {
        await api.postRaw(`/api/soundboard/upload?name=${encodeURIComponent(name)}`, wav);
        toast('success', 'Добавлено в Soundboard');
      } catch (e) { toast('error', (e as Error).message); }
      return;
    }

    const beside = sourcePath && isElectron()
      ? await confirmDialog('Место сохранения', `Сохранить рядом с оригиналом?\n\n«Да» — рядом с исходным файлом\n«Нет» — в каталог приложения (cache/exports)`, 'Рядом с оригиналом')
      : false;

    const saveIt = async (overwrite: boolean): Promise<void> => {
      const q = new URLSearchParams({ name, overwrite: overwrite ? '1' : '0' });
      if (beside && sourcePath) q.set('beside', '1'), q.set('source', sourcePath);
      try {
        const r = await api.postRaw<{ path: string }>('/api/editor/save?' + q.toString(), wav);
        toast('success', `Экспортировано: ${r.path}`);
      } catch (e) {
        const err = e as Error & { data?: { code?: string } };
        if (err.data?.code === 'EXISTS') {
          const ok = await confirmDialog('Файл существует', 'Файл с таким именем уже существует. Перезаписать без возможности восстановления?', 'Перезаписать', true);
          if (ok) await saveIt(true);
          return;
        }
        throw err;
      }
    };

    try {
      await saveIt(false);
    } catch (e) {
      toast('error', 'Не удалось экспортировать: ' + (e as Error).message);
      return;
    }

    if (kind === 'mp3') {
      try {
        const r = await api.postRaw<{ path: string }>(`/api/editor/mp3?name=${encodeURIComponent(name)}&overwrite=1`, wav);
        toast('success', `MP3 экспортирован: ${r.path}`);
      } catch (e) {
        toast('error', (e as Error).message);
      }
    }
  }

  // Ресайз → перерисовка
  const onResize = (): void => { if (buffer) { drawWave(); } };
  window.addEventListener('resize', onResize);

  void refreshSources();
  void modal;
  void promptDialog;
  void spinner;
  void emptyState;
  void snapshotListener;
  void playing;
  void raf;

  return {
    teardown: () => {
      stopPlay();
      window.removeEventListener('resize', onResize);
    }
  };
}

// Хранилище для updateInfoRow (замыкание между функциями страницы)
declare global {
  interface Window { __updateInfo?: () => void }
}
function updateInfoRow(): void {
  window.__updateInfo?.();
}
