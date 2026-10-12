import * as path from 'path';
import { Request, Response, NextFunction, RequestHandler } from 'express';

/** Проверяет, что путь лежит строго внутри одного из разрешённых корней. */
export function safeResolve(roots: string[], p: string): string | null {
  if (!p || typeof p !== 'string' || p.includes('\0')) return null;
  let resolved: string;
  try {
    resolved = path.resolve(p);
  } catch {
    return null;
  }
  for (const root of roots) {
    const r = path.resolve(root);
    const rel = path.relative(r, resolved);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
      return resolved;
    }
  }
  return null;
}

export function isLoopback(req: Request): boolean {
  const addr = req.socket.remoteAddress || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr === '::ffff:127.0.0.1%0';
}

function extractToken(req: Request): string {
  const header = req.headers['x-auth-token'];
  if (typeof header === 'string' && header) return header;
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7);
  const q = req.query['token'];
  if (typeof q === 'string' && q) return q;
  return '';
}

export interface AuthState {
  lanEnabled: boolean;
  token: string;
  pin: string;
}

/** Экспорт для тестов: проверка токена. */
export function checkToken(req: Request, auth: AuthState): boolean {
  return extractToken(req) === auth.token && auth.token.length > 0;
}

/**
 * Миддлвара авторизации:
 *  - loopback (127.0.0.1) — полный доступ без токена;
 *  - LAN — если доступ включён, требуется токен (получается по PIN-коду);
 *  - LAN выключен — доступ извне запрещён полностью.
 */
export function createAuthMiddleware(getAuth: () => AuthState): RequestHandler {
  const attempts = new Map<string, { fails: number; until: number }>();

  return (req: Request, res: Response, next: NextFunction) => {
    const url = req.path;
    if (url === '/api/health' || url === '/api/auth/login') return next();
    if (isLoopback(req)) return next();

    const auth = getAuth();
    if (!auth.lanEnabled) {
      return res.status(403).json({ error: 'Доступ по локальной сети отключён. Включите его в настройках приложения на компьютере.', code: 'LAN_DISABLED' });
    }
    if (checkToken(req, auth)) return next();
    return res.status(401).json({ error: 'Требуется авторизация. Введите PIN-код из настроек Sonic Studio.', code: 'AUTH_REQUIRED' });
  };
}

const MIME: Record<string, string> = {
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.flac': 'audio/flac', '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.opus': 'audio/ogg',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.m4v': 'video/mp4', '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.gif': 'image/gif', '.svg': 'image/svg+xml'
};

export function mimeFor(ext: string): string {
  return MIME[ext.toLowerCase()] || 'application/octet-stream';
}

/** Простая защита от перебора PIN: не более 5 ошибок, затем блок на 60 секунд. */
export class LoginGuard {
  private state = new Map<string, { fails: number; until: number }>();

  canAttempt(ip: string): { ok: boolean; retryAfterSec: number } {
    const s = this.state.get(ip);
    if (!s) return { ok: true, retryAfterSec: 0 };
    if (s.until > Date.now()) {
      return { ok: false, retryAfterSec: Math.ceil((s.until - Date.now()) / 1000) };
    }
    return { ok: true, retryAfterSec: 0 };
  }

  fail(ip: string): void {
    const s = this.state.get(ip) || { fails: 0, until: 0 };
    s.fails += 1;
    if (s.fails >= 5) {
      s.until = Date.now() + 60_000;
      s.fails = 0;
    }
    this.state.set(ip, s);
  }

  reset(ip: string): void {
    this.state.delete(ip);
  }
}
