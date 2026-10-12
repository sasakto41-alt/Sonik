import * as crypto from 'crypto';
import { Request, Response, NextFunction, RequestHandler } from 'express';

export function uuid(): string {
  return crypto.randomUUID();
}

export function randomPin(): string {
  return String(crypto.randomInt(100000, 999999));
}

export function randomToken(): string {
  return crypto.randomBytes(24).toString('hex');
}

/** Обёртка для async-обработчиков: ловит ошибки и отвечает понятным JSON. */
export function ah(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message || 'Внутренняя ошибка сервера' });
    });
  };
}

export function fail(res: Response, status: number, message: string, code?: string): void {
  res.status(status).json({ error: message, ...(code ? { code } : {}) });
}

export function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim();
  return cleaned.slice(0, 120) || 'file';
}

export function extOf(p: string): string {
  const i = p.lastIndexOf('.');
  return i >= 0 ? p.slice(i).toLowerCase() : '';
}

export function humanBytes(n: number): string {
  if (!n) return '0 Б';
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}
