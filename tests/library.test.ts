import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ensurePaths } from '../dist/server/paths';
import { Logger } from '../dist/server/logger';
import { MusicCatalog } from '../dist/server/library-music';
import { VideoCatalog } from '../dist/server/library-videos';

function makeWavFile(p: string, seconds = 1): void {
  // Минимальный корректный WAV (PCM 16 бит, моно, 8 кГц) — music-metadata прочитает длительность
  const sampleRate = 8000;
  const samples = sampleRate * seconds;
  const dataSize = samples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples; i++) {
    const v = Math.round(Math.sin(i / 12) * 12000);
    buf.writeInt16LE(v, 44 + i * 2);
  }
  fs.writeFileSync(p, buf);
}

test('Медиатека музыки: сканирование папки, поиск, избранное, история', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonic-lib-'));
  const musicDir = path.join(dataDir, 'music');
  fs.mkdirSync(path.join(musicDir, 'sub'), { recursive: true });
  makeWavFile(path.join(musicDir, 'track one.wav'), 2);
  makeWavFile(path.join(musicDir, 'sub', 'deep track.wav'), 3);
  fs.writeFileSync(path.join(musicDir, 'notaudio.txt'), 'не аудио');

  const paths = ensurePaths(dataDir);
  const log = new Logger(paths.logs);
  const cat = new MusicCatalog(paths, log);

  const r = await cat.scan([musicDir], paths.covers);
  assert.equal(r.added, 2, 'должно быть найдено 2 аудиофайла (wav), txt пропущен');
  const tracks = cat.list();
  assert.equal(tracks.length, 2);
  const t1 = tracks.find(t => t.title.includes('track one'));
  assert.ok(t1);
  assert.ok(t1!.duration > 1.5 && t1!.duration < 2.6, 'длительность прочитана из WAV');
  assert.equal(t1!.format, 'wav');

  // Поиск
  assert.equal(cat.list({ search: 'deep' }).length, 1);

  // Избранное
  cat.setFavorite(t1!.id, true);
  assert.equal(cat.list({ favorite: true }).length, 1);

  // История
  cat.addHistory(t1!);
  assert.equal(cat.getHistory().length, 1);
  assert.ok(cat.byId(t1!.id)!.playCount === 1);

  // Повторное сканирование не дублирует
  const r2 = await cat.scan([musicDir], paths.covers);
  assert.equal(r2.added, 0);
  assert.equal(cat.list().length, 2);

  // Удаление файла → missing
  fs.unlinkSync(t1!.path);
  await cat.scan([musicDir], paths.covers);
  const missing = cat.byId(t1!.id)!;
  assert.equal(missing.missing, true, 'файл удалён → missing=true');

  // Удаление из библиотеки
  assert.ok(cat.remove(t1!.id));
  assert.equal(cat.list().length, 1);

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('Медиатека видео: импорт, настройки, миниатюры, история', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonic-vid-'));
  const vidDir = path.join(dataDir, 'videos');
  fs.mkdirSync(vidDir, { recursive: true });
  fs.writeFileSync(path.join(vidDir, 'clip.mp4'), Buffer.alloc(1024, 1));
  fs.writeFileSync(path.join(vidDir, 'doc.pdf'), Buffer.alloc(10));

  const paths = ensurePaths(dataDir);
  const log = new Logger(paths.logs);
  const cat = new VideoCatalog(paths, log);

  const r = cat.scan([vidDir]);
  assert.equal(r.added, 1, 'только mp4 добавлен');
  const v = cat.list()[0];
  assert.ok(v);
  assert.equal(v.format, 'mp4');

  // Настройки ролика
  const upd = cat.updateSettings(v.id, { fadeIn: 2.5, fadeOut: 1, volume: 0.4, afterAction: 'next' });
  assert.ok(upd);
  assert.equal(upd!.fadeIn, 2.5);
  assert.equal(upd!.volume, 0.4);
  assert.equal(upd!.afterAction, 'next');

  // Некорректные ключи не применяются
  cat.updateSettings(v.id, { path: '/hack' } as never);
  assert.notEqual(cat.byId(v.id)!.path, '/hack');

  // История
  cat.addHistory(cat.byId(v.id)!);
  assert.equal(cat.getHistory().length, 1);

  // Миниатюра
  fs.writeFileSync(path.join(paths.thumbs, 'thumb-x.jpg'), Buffer.alloc(50));
  cat.setThumbFile(v.id, "thumb-x.jpg");
  assert.equal(cat.byId(v.id)!.thumbFile, 'thumb-x.jpg');

  fs.rmSync(dataDir, { recursive: true, force: true });
});
