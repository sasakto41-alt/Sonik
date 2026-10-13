import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import type { Server } from 'http';
import { WsOut, WsIn } from '../shared/types';

export interface WsClient {
  socket: WebSocket;
  role: 'ui' | 'stage';
  loopback: boolean;
  /** Идентификатор устройства (локальный хранилище браузера), если передан. */
  deviceId: string;
  ua: string;
  ip: string;
}

/**
 * Хаб WebSocket: рассылка снимков состояния, команд и уведомлений.
 * Клиенты: основное окно/браузеры (role=ui) и окно сценического вывода (role=stage).
 */
export class WsHub {
  private wss: WebSocketServer;
  private clients = new Set<WsClient>();
  private msgHandler: ((msg: WsIn, client: WsClient) => void) | null = null;

  constructor(
    server: Server,
    private authCheck: (req: IncomingMessage) => boolean,
    private onClientChange?: (client: WsClient, connected: boolean) => void
  ) {
    this.wss = new WebSocketServer({ server, path: '/ws' });
    this.wss.on('connection', (socket, req) => {
      if (!this.authCheck(req)) {
        socket.close(4401, 'Требуется авторизация');
        return;
      }
      const url = new URL(req.url || '/', 'http://localhost');
      const client: WsClient = {
        socket,
        role: url.searchParams.get('role') === 'stage' ? 'stage' : 'ui',
        loopback: this.isLoopback(req),
        deviceId: (url.searchParams.get('device') || '').slice(0, 64),
        ua: String(req.headers['user-agent'] || ''),
        ip: req.socket.remoteAddress || ''
      };
      this.clients.add(client);
      this.onClientChange?.(client, true);
      socket.on('message', (raw) => {
        try {
          const msg = JSON.parse(String(raw)) as WsIn;
          this.msgHandler?.(msg, client);
        } catch {
          /* некорректное сообщение игнорируем */
        }
      });
      socket.on('close', () => {
        this.clients.delete(client);
        this.onClientChange?.(client, false);
      });
      socket.on('error', () => {
        this.clients.delete(client);
        this.onClientChange?.(client, false);
      });
      this.send(client, { type: 'hello', version: 1, electron: false });
    });
  }

  private isLoopback(req: IncomingMessage): boolean {
    const addr = req.socket.remoteAddress || '';
    return addr === '127.0.0.1' || addr === '::1' || addr.startsWith('::ffff:127.');
  }

  onMessage(cb: (msg: WsIn, client: WsClient) => void): void {
    this.msgHandler = cb;
  }

  send(client: WsClient, msg: WsOut): void {
    if (client.socket.readyState === WebSocket.OPEN) {
      client.socket.send(JSON.stringify(msg));
    }
  }

  broadcast(msg: WsOut): void {
    const data = JSON.stringify(msg);
    for (const c of this.clients) {
      if (c.socket.readyState === WebSocket.OPEN) c.socket.send(data);
    }
  }

  sendToRoles(roles: Array<'ui' | 'stage'>, msg: WsOut): void {
    const data = JSON.stringify(msg);
    for (const c of this.clients) {
      if (roles.includes(c.role) && c.socket.readyState === WebSocket.OPEN) c.socket.send(data);
    }
  }

  /** Адресные команды: только соединения конкретного устройства. */
  sendToDevice(deviceId: string, msg: WsOut): boolean {
    const data = JSON.stringify(msg);
    let sent = false;
    for (const c of this.clients) {
      if (c.deviceId === deviceId && c.socket.readyState === WebSocket.OPEN) {
        c.socket.send(data);
        sent = true;
      }
    }
    return sent;
  }

  /** Устройства, у которых сейчас открыто соединение. */
  onlineDeviceIds(): Set<string> {
    const ids = new Set<string>();
    for (const c of this.clients) {
      if (c.deviceId && !c.loopback) ids.add(c.deviceId);
    }
    return ids;
  }

  /** Устройства, которые прямо сейчас показывают сцену (role=stage). */
  stageDeviceIds(): Set<string> {
    const ids = new Set<string>();
    for (const c of this.clients) {
      if (c.deviceId && !c.loopback && c.role === 'stage') ids.add(c.deviceId);
    }
    return ids;
  }

  closeAll(): void {
    for (const c of this.clients) {
      try { c.socket.close(1001, 'Сервер остановлен'); } catch { /* ignore */ }
    }
    this.clients.clear();
  }

  async close(): Promise<void> {
    this.closeAll();
    return new Promise((resolve) => this.wss.close(() => resolve()));
  }
}
