import * as fs from 'fs';
import { Request, Response } from 'express';
import { safeResolve, mimeFor } from './security';
import { extOf } from './util';

/**
 * Стриминг медиафайла с поддержкой Range-запросов (перемотка).
 * Путь обязан находиться внутри одного из разрешённых корней.
 */
export function streamFile(req: Request, res: Response, filePath: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    res.status(404).json({ error: 'Файл не найден. Возможно, он был перемещён или удалён.' });
    return;
  }
  if (!stat.isFile()) {
    res.status(404).json({ error: 'Файл не найден' });
    return;
  }
  const mime = mimeFor(extOf(filePath));
  const range = req.headers.range;
  const baseHeaders: Record<string, string> = {
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache'
  };

  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end = m[2] ? Math.min(parseInt(m[2], 10), stat.size - 1) : stat.size - 1;
      if (start >= stat.size || start > end) {
        res.status(416).set({ 'Content-Range': `bytes */${stat.size}` }).end();
        return;
      }
      res.writeHead(206, {
        ...baseHeaders,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Content-Length': end - start + 1
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
      return;
    }
  }
  res.writeHead(200, { ...baseHeaders, 'Content-Length': stat.size });
  fs.createReadStream(filePath).pipe(res);
}

/** Стриминг с проверкой пути по разрешённым корням. */
export function streamChecked(req: Request, res: Response, roots: string[], p: string): void {
  const resolved = safeResolve(roots, p);
  if (!resolved) {
    res.status(403).json({ error: 'Доступ к этому файлу запрещён: путь вне разрешённых каталогов.' });
    return;
  }
  streamFile(req, res, resolved);
}
