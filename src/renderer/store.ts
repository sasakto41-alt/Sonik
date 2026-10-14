import { Snapshot } from '../shared/types';
import { api, wsUrl } from './api';

/**
 * Клиентский store: снимок состояния внутреннего сервера + WebSocket с автопереподключением.
 * Состояние соединения показывается маленькой точкой в шапке — без баннеров и тостов.
 */

export type StoreEvent =
  | { type: 'snapshot'; snapshot: Snapshot }
  | { type: 'connected' }
  | { type: 'disconnected' }
  | { type: 'command'; target: string; domain: string; action: string; payload?: unknown };

type Listener = (e: StoreEvent) => void;

class Store {
  snapshot: Snapshot | null = null;
  connected = false;
  everConnected = false;
  private listeners = new Set<Listener>();
  private ws: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private reconnectDelay = 1000;

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(e: StoreEvent): void {
    this.listeners.forEach(fn => {
      try { fn(e); } catch { /* ошибка в подписчике не роняет стор */ }
    });
  }

  private emitEvent(e: StoreEvent): void {
    this.emit(e);
  }

  connect(): void {
    this.openSocket();
  }

  private openSocket(): void {
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.reconnectDelay = 1000;
      this.connected = true;
      this.everConnected = true;
      this.emitEvent({ type: 'connected' });
      // Подтягиваем свежий снимок после переподключения
      api.get<Snapshot>('/api/state').then(s => {
        this.applySnapshot(s);
      }).catch(() => { /* 401 обработается в api */ });
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data));
        if (msg.type === 'snapshot') this.applySnapshot(msg.snapshot as Snapshot);
        else if (msg.type === 'command') this.emit({ type: 'command', target: msg.target, domain: msg.domain, action: msg.action, payload: msg.payload });
        else if (msg.type === 'toast') {
          // тосты обрабатываются в main.ts через подписку
          this.emit({ type: 'command', target: 'toast', domain: 'toast', action: msg.level, payload: msg.message });
        }
      } catch { /* некорректный кадр игнорируем */ }
    };
    ws.onclose = () => {
      this.connected = false;
      this.emitEvent({ type: 'disconnected' });
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      try { ws.close(); } catch { /* ignore */ }
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 1.6, 8000);
      this.openSocket();
    }, this.reconnectDelay);
  }

  applySnapshot(s: Snapshot): void {
    this.snapshot = s;
    this.emit({ type: 'snapshot', snapshot: s });
  }

  /** Мгновенная оценка позиции (интерполяция между отчётами сервера). */
  estimatePosition(kind: 'player' | 'stage'): number {
    if (!this.snapshot) return 0;
    const st = kind === 'player' ? this.snapshot.player : this.snapshot.stage;
    const age = (Date.now() - st.updatedAt) / 1000;
    if (st.status === 'playing' && st.duration > 0) {
      return Math.min(st.position + age, st.duration);
    }
    return st.position;
  }
}

export const store = new Store();

/** Локальная настройка веб-клиента (не серверная). */
export function localPref(key: string, def: string): string {
  return localStorage.getItem('sonic.pref.' + key) ?? def;
}
export function setLocalPref(key: string, value: string): void {
  localStorage.setItem('sonic.pref.' + key, value);
}
