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

/**
 * Приложение полностью локальное: управление — только с этого компьютера.
 * Сервер слушает 127.0.0.1, так что запросы извне просто не доходят;
 * миддлвара — вторая линия обороны на случай прокси/форвардинга.
 */
export function createAuthMiddleware(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.path === '/api/health') return next();
    if (isLoopback(req)) return next();
    return res.status(403).json({
      error: 'Sonic Studio работает только на этом компьютере. Доступ из сети отключён.',
      code: 'LOCAL_ONLY'
    });
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
