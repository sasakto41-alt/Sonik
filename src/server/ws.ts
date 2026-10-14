import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import type { Server } from 'http';
import { WsOut, WsIn } from '../shared/types';

export interface WsClient {
  socket: WebSocket;
  role: 'ui' | 'stage';
}

/**
 * Хаб WebSocket: рассылка снимков состояния, команд и уведомлений.
 * Клиенты: главное окно (role=ui) и окно сценического вывода (role=stage).
 * Приложение локальное — внешние соединения не допускаются.
 */
export class WsHub {
  private wss: WebSocketServer;
  private clients = new Set<WsClient>();
  private msgHandler: ((msg: WsIn, client: WsClient) => void) | null = null;

  constructor(
    server: Server,
    private authCheck: (req: IncomingMessage) => boolean
  ) {
    this.wss = new WebSocketServer({ server, path: '/ws' });
    this.wss.on('connection', (socket, req) => {
      if (!this.authCheck(req)) {
        socket.close(4403, 'Только локальное подключение');
        return;
      }
      const url = new URL(req.url || '/', 'http://localhost');
      const client: WsClient = {
        socket,
        role: url.searchParams.get('role') === 'stage' ? 'stage' : 'ui'
      };
      this.clients.add(client);
      socket.on('message', (raw) => {
        try {
          const msg = JSON.parse(String(raw)) as WsIn;
          this.msgHandler?.(msg, client);
        } catch {
          /* некорректное сообщение игнорируем */
        }
      });
      socket.on('close', () => this.clients.delete(client));
      socket.on('error', () => this.clients.delete(client));
      this.send(client, { type: 'hello', version: 1, electron: false });
    });
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
