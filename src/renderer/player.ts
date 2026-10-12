import { EQ_BANDS, PlayerState, RepeatMode, EqState, Track, Snapshot } from '../shared/types';
import { api, mediaUrl, isElectron } from './api';
import { store } from './store';
import { toast } from './ui';

/**
 * Музыкальный плеер.
 * - один элемент <audio> — два трека физически не могут играть одновременно;
 * - Web Audio: source → 10 биквад-фильтров (эквалайзер) → анализатор → громкость → выход;
 * - desktop-версия отчитывается на сервер (источник истины), веб-версия управляет
 *   плеером на компьютере командами через сервер.
 */

type Events = {
  state: (p: PlayerState) => void;
  track: (t: Track | null) => void;
};

type ListenerOff = () => void;

class MusicPlayer {
  audio: HTMLAudioElement;
  /** Локальное состояние для desktop (веб читает снапшот сервера). */
  state: PlayerState = {
    trackId: null, title: '', artist: '', status: 'stopped', position: 0, duration: 0,
    volume: 0.9, muted: false, shuffle: false, repeat: 'off', queue: [], queueIndex: -1,
    updatedAt: Date.now()
  };

  desktop = isElectron();
  private ctx: AudioContext | null = null;
  private srcNode: MediaElementAudioSourceNode | null = null;
  private eqNodes: BiquadFilterNode[] = [];
  private analyser: AnalyserNode | null = null;
  private outGain: GainNode | null = null;
  private eqEnabled = false;
  private shuffledOrder: string[] = [];
  private reportTimer: number | null = null;
  private lastReportAt = 0;
  /** Несколько слушателей: панель плеера, быстрый режим и другие страницы независимы. */
  private listeners: { [K in keyof Events]: Events[K][] } = { state: [], track: [] };
  private currentTrack: Track | null = null;
  /** Эхо-подавление: игнорировать snapshot-обновления плеера, если это наш отчёт. */
  private suppressSnapshotUntil = 0;

  constructor() {
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.audio.addEventListener('timeupdate', () => {
      this.state.position = this.audio.currentTime;
      this.emitState();
      this.maybeReport();
    });
    this.audio.addEventListener('durationchange', () => {
      this.state.duration = isFinite(this.audio.duration) ? this.audio.duration : 0;
      this.emitState();
    });
    this.audio.addEventListener('ended', () => void this.onEnded());
    this.audio.addEventListener('error', () => {
      if (this.state.trackId) {
        void this.markMissing(this.state.trackId);
      }
    });
    // Критично: реальное состояние аудиоэлемента — единственный источник истины
    // по статусу. Без этих обработчиков status остаётся 'playing' после паузы,
    // и toggle() повторно вызывает pause() вместо play() (плей/пауза «не работают»).
    this.audio.addEventListener('play', () => {
      this.state.status = 'playing';
      this.emitState();
      this.report(true);
    });
    this.audio.addEventListener('pause', () => {
      // 'pause' также срабатывает при подмене src и по завершении трека —
      // в этих случаях статус уже управляется другой логикой.
      if (this.state.status === 'stopped' || this.audio.ended) return;
      this.state.status = 'paused';
      this.emitState();
      this.report(true);
    });
  }

  /** Подписка на событие; возвращает функцию отписки. */
  on<K extends keyof Events>(evt: K, fn: Events[K]): ListenerOff {
    const list = this.listeners[evt] as Events[K][];
    list.push(fn);
    return () => {
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    };
  }

  private emitState(): void {
    for (const fn of [...this.listeners.state]) fn(this.state);
  }

  getAnalyser(): AnalyserNode | null {
    return this.analyser;
  }

  /** Построение Web Audio-графа при первом воспроизведении. */
  private ensureGraph(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    try {
      this.ctx = new AudioContext();
      this.srcNode = this.ctx.createMediaElementSource(this.audio);
      this.eqNodes = EQ_BANDS.map((freq, i) => {
        const f = this.ctx!.createBiquadFilter();
        f.type = i === 0 ? 'lowshelf' : i === EQ_BANDS.length - 1 ? 'highshelf' : 'peaking';
        f.frequency.value = freq;
        f.Q.value = 1.1;
        f.gain.value = 0;
        return f;
      });
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.82;
      this.outGain = this.ctx.createGain();
      this.rewire();
      this.srcNode.connect(this.eqNodes[0]);
    } catch {
      // Web Audio недоступен — обычное воспроизведение без EQ
      this.ctx = null;
    }
  }

  private rewire(): void {
    if (!this.ctx || !this.srcNode || !this.analyser || !this.outGain) return;
    try { this.srcNode.disconnect(); } catch { /* ignore */ }
    if (this.eqEnabled && this.eqNodes.length > 0) {
      this.srcNode.connect(this.eqNodes[0]);
      for (let i = 0; i < this.eqNodes.length - 1; i++) {
        try { this.eqNodes[i].disconnect(); } catch { /* ignore */ }
        this.eqNodes[i].connect(this.eqNodes[i + 1]);
      }
      try { this.eqNodes[this.eqNodes.length - 1].disconnect(); } catch { /* ignore */ }
      this.eqNodes[this.eqNodes.length - 1].connect(this.analyser);
    } else {
      this.srcNode.connect(this.analyser);
    }
    try { this.analyser.disconnect(); } catch { /* ignore */ }
    this.analyser.connect(this.outGain);
    try { this.outGain.disconnect(); } catch { /* ignore */ }
    this.outGain.connect(this.ctx.destination);
  }

  applyEq(eq: EqState): void {
    this.eqEnabled = eq.enabled;
    if (this.eqNodes.length === EQ_BANDS.length) {
      EQ_BANDS.forEach((_, i) => {
        this.eqNodes[i].gain.value = eq.enabled ? (eq.gains[i] || 0) : 0;
      });
    }
    this.rewire();
  }

  // ─── Управление ───

  async playTrack(id: string, queue?: string[]): Promise<void> {
    this.ensureGraph();
    const t = await this.fetchTrack(id);
    if (!t) return;
    if (queue && queue.length) {
      this.state.queue = [...queue];
    } else if (!this.state.queue.includes(id)) {
      this.state.queue = [id];
    }
    this.state.queueIndex = this.state.queue.indexOf(id);
    if (this.state.shuffle) this.buildShuffleOrder(id);
    await this.loadAndPlay(t);
  }

  async toggle(): Promise<void> {
    if (this.state.status === 'playing') this.pause();
    else await this.resume();
  }

  async resume(): Promise<void> {
    if (!this.state.trackId) {
      if (this.state.queue.length > 0) {
        const idx = Math.max(0, this.state.queueIndex);
        await this.playTrack(this.state.queue[idx]);
      } else {
        toast('info', 'Очередь пуста — выберите трек в разделе «Музыка»');
      }
      return;
    }
    this.ensureGraph();
    try {
      await this.audio.play();
      this.state.status = 'playing';
      this.emitState();
    } catch { /* требуется жест пользователя */ }
  }

  pause(): void {
    this.audio.pause();
  }

  seek(t: number): void {
    if (isFinite(t) && t >= 0) this.audio.currentTime = t;
  }

  setVolume(v: number): void {
    this.state.volume = Math.min(1, Math.max(0, v));
    this.state.muted = false;
    this.applyVolume();
  }

  setMuted(m: boolean): void {
    this.state.muted = m;
    this.applyVolume();
  }

  private applyVolume(): void {
    this.audio.volume = this.state.muted ? 0 : this.state.volume;
    if (this.outGain) this.outGain.gain.value = 1;
  }

  toggleShuffle(): void {
    this.state.shuffle = !this.state.shuffle;
    if (this.state.shuffle) this.buildShuffleOrder(this.state.trackId || undefined);
  }

  cycleRepeat(): void {
    const order: RepeatMode[] = ['off', 'all', 'one'];
    this.state.repeat = order[(order.indexOf(this.state.repeat) + 1) % 3];
  }

  async next(user = true): Promise<void> {
    const id = this.pickNext(1);
    if (id) await this.playTrack(id);
    else if (!user) {
      this.state.status = 'stopped';
      this.state.position = 0;
      this.emitState();
      this.report(true);
    }
  }

  async prev(): Promise<void> {
    if (this.audio.currentTime > 3) {
      this.seek(0);
      return;
    }
    const id = this.pickNext(-1);
    if (id) await this.playTrack(id);
  }

  addToQueue(id: string, next = false): void {
    if (next && this.state.queueIndex >= 0) this.state.queue.splice(this.state.queueIndex + 1, 0, id);
    else this.state.queue.push(id);
    if (this.state.shuffle) this.buildShuffleOrder(this.state.trackId || undefined);
    this.emitState();
    this.report(true);
  }

  removeQueueItem(index: number): void {
    if (index < 0 || index >= this.state.queue.length) return;
    this.state.queue.splice(index, 1);
    if (index < this.state.queueIndex) this.state.queueIndex--;
    this.emitState();
    this.report(true);
  }

  clearQueue(): void {
    this.state.queue = this.state.trackId ? [this.state.trackId] : [];
    this.state.queueIndex = this.state.trackId ? 0 : -1;
    this.emitState();
    this.report(true);
  }

  async jumpTo(index: number): Promise<void> {
    const id = this.state.queue[index];
    if (id) await this.playTrack(id);
  }

  private pickNext(dir: 1 | -1): string | null {
    const q = this.state.queue;
    if (q.length === 0) return null;
    if (this.state.shuffle) {
      const idx = this.shuffledOrder.indexOf(this.state.trackId || '');
      let next = idx + dir;
      if (next >= this.shuffledOrder.length) {
        if (this.state.repeat === 'all' || dir === 1) next = 0;
        else return null;
      }
      if (next < 0) next = this.shuffledOrder.length - 1;
      return this.shuffledOrder[next] || null;
    }
    let idx = this.state.queueIndex + dir;
    if (idx >= q.length) {
      if (this.state.repeat === 'all') idx = 0;
      else return null;
    }
    if (idx < 0) idx = q.length - 1;
    return q[idx] || null;
  }

  private buildShuffleOrder(current?: string): void {
    const pool = [...this.state.queue];
    // Фишер-Йетс
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    if (current) {
      const i = pool.indexOf(current);
      if (i > 0) { pool.splice(i, 1); pool.unshift(current); }
    }
    this.shuffledOrder = pool;
  }

  private async onEnded(): Promise<void> {
    if (this.state.repeat === 'one') {
      this.seek(0);
      await this.audio.play().catch(() => {});
      return;
    }
    await this.next(false);
  }

  private async fetchTrack(id: string): Promise<Track | null> {
    try {
      const r = await api.get<{ tracks: Track[] }>('/api/music/tracks');
      const t = r.tracks.find(x => x.id === id) || null;
      this.currentTrack = t;
      for (const fn of [...this.listeners.track]) fn(t);
      return t;
    } catch {
      return null;
    }
  }

  private async loadAndPlay(t: Track): Promise<void> {
    if (t.missing) {
      toast('error', `Файл отсутствует на диске: ${t.title}`);
      this.emitState();
      return;
    }
    this.state.trackId = t.id;
    this.state.title = t.title;
    this.state.artist = t.artist;
    // Сначала src, затем play(): подмена src вызывает 'pause', обработчик
    // которого не должен оставить ложный 'paused' — после успешного play()
    // статус устанавливается явно (и событием 'play').
    this.audio.src = mediaUrl(`/api/media/audio/${t.id}`);
    try {
      await this.audio.play();
      this.state.status = 'playing';
    } catch {
      this.state.status = 'paused';
    }
    this.applyVolume();
    this.emitState();
    this.report(true);
  }

  private async markMissing(id: string): Promise<void> {
    try {
      await api.post('/api/music/missing', { id, missing: true });
    } catch { /* ignore */ }
  }

  /** Выполнение команды с сервера (телефон → компьютер). */
  async command(action: string, payload: Record<string, unknown> = {}): Promise<void> {
    switch (action) {
      case 'play': await this.resume(); break;
      case 'pause': this.pause(); break;
      case 'toggle': await this.toggle(); break;
      case 'next': await this.next(); break;
      case 'prev': await this.prev(); break;
      case 'stop':
        this.pause();
        this.seek(0);
        this.state.status = 'stopped';
        this.emitState();
        this.report(true);
        break;
      case 'seek': this.seek(Number(payload.time) || 0); break;
      case 'setVolume': this.setVolume(Number(payload.volume)); break;
      case 'setMuted': this.setMuted(Boolean(payload.muted)); break;
      case 'toggleShuffle': this.toggleShuffle(); break;
      case 'cycleRepeat': this.cycleRepeat(); break;
      case 'playTrack': await this.playTrack(String(payload.trackId), payload.queue as string[] | undefined); break;
      case 'addToQueue': this.addToQueue(String(payload.trackId), Boolean(payload.next)); break;
      case 'removeQueueItem': this.removeQueueItem(Number(payload.index)); break;
      case 'clearQueue': this.clearQueue(); break;
      case 'setQueueIndex': await this.jumpTo(Number(payload.index)); break;
    }
  }

  /** Веб-режим: команда уходит на сервер, десктопный плеер её исполняет. */
  async remoteCommand(action: string, payload: Record<string, unknown> = {}): Promise<void> {
    try {
      await api.post('/api/player/command', { action, payload });
    } catch { /* ошибка тостом в api */ }
  }

  // ─── Синхронизация ───

  private maybeReport(): void {
    const now = Date.now();
    if (now - this.lastReportAt > 950) this.report(true);
  }

  report(force = false): void {
    if (!this.desktop) return;
    const now = Date.now();
    if (!force && now - this.lastReportAt < 800) return;
    this.lastReportAt = now;
    this.suppressSnapshotUntil = now + 1200;
    void api.post('/api/player/report', {
      trackId: this.state.trackId,
      status: this.state.status,
      position: this.state.position,
      duration: this.state.duration,
      volume: this.state.volume,
      muted: this.state.muted,
      shuffle: this.state.shuffle,
      repeat: this.state.repeat,
      queue: this.state.queue,
      queueIndex: this.state.queueIndex
    }).catch(() => {});
  }

  /** Применение снапшота для веб-клиентов (десктоп сам источник истины). */
  applySnapshot(s: Snapshot): void {
    if (this.desktop) {
      if (Date.now() < this.suppressSnapshotUntil) return;
      // Применяем только внешние изменения (например, повтор/шафл с телефона)
      const p = s.player;
      if (p.repeat !== this.state.repeat) this.state.repeat = p.repeat;
      if (p.shuffle !== this.state.shuffle) {
        this.state.shuffle = p.shuffle;
        if (p.shuffle) this.buildShuffleOrder(this.state.trackId || undefined);
      }
      if (Math.abs(p.volume - this.state.volume) > 0.001) {
        this.state.volume = p.volume;
        this.applyVolume();
      }
      if (p.muted !== this.state.muted) {
        this.state.muted = p.muted;
        this.applyVolume();
      }
      this.emitState();
      return;
    }
    // Веб-клиент: локальная копия состояния
    this.state = { ...s.player };
    this.emitState();
    const t = this.state.trackId;
    if (t && (!this.currentTrack || this.currentTrack.id !== t)) {
      void this.fetchTrack(t);
    } else if (!t) {
      this.currentTrack = null;
      for (const fn of [...this.listeners.track]) fn(null);
    }
  }

  startReporting(): void {
    if (this.reportTimer !== null) return;
    this.reportTimer = window.setInterval(() => {
      if (this.state.status === 'playing') this.report(true);
    }, 1000);
  }
}

export const player = new MusicPlayer();
