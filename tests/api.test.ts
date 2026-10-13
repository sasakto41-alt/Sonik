import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { startSonicServer, RunningServer } from '../dist/server/index';

/**
 * Интеграционные тесты HTTP API на реальном сервере (standalone, эфемерный порт).
 */

let server: RunningServer;
let dataDir: string;

function url(p: string): string {
  return `http://127.0.0.1:${server.port}${p}`;
}

async function jget<T>(p: string): Promise<{ status: number } & T> {
  const r = await fetch(url(p));
  const json = await r.json() as Record<string, unknown>;
  return Object.assign({ status: r.status }, json) as { status: number } & T;
}

async function jpost<T>(p: string, body?: unknown): Promise<{ status: number } & T> {
  const r = await fetch(url(p), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const json = await r.json() as Record<string, unknown>;
  return Object.assign({ status: r.status }, json) as { status: number } & T;
}

async function jput<T>(p: string, body: unknown): Promise<{ status: number } & T> {
  const r = await fetch(url(p), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const json = await r.json() as Record<string, unknown>;
  return Object.assign({ status: r.status }, json) as { status: number } & T;
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonic-api-'));
  server = await startSonicServer({ dataDir, port: 0, electron: false, appVersion: 'test' });
});

after(async () => {
  await server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('GET /api/health отвечает', async () => {
  const r = await fetch(url('/api/health'));
  assert.equal(r.status, 200);
  const body = await r.json() as { ok: boolean; app: string };
  assert.equal(body.ok, true);
  assert.equal(body.app, 'Sonic Studio');
});

test('GET /api/state возвращает согласнованный снимок', async () => {
  const r = await jget<{ status: number; player: { status: string }; stage: { status: string }; system: { electron: boolean }; displays: unknown[] }>('/api/state');
  assert.equal(r.status, 200);
  assert.equal(r.player.status, 'stopped');
  assert.equal(r.stage.status, 'idle');
  assert.equal(r.system.electron, false);
  assert.ok(Array.isArray(r.displays));
});

test('Команды плеера меняют состояние (setVolume, toggleShuffle)', async () => {
  const r1 = await jpost<{ ok: boolean }>('/api/player/command', { action: 'setVolume', payload: { volume: 0.55 } });
  assert.equal(r1.status, 200);
  const s1 = await jget<{ player: { volume: number } }>('/api/state');
  assert.equal(s1.player.volume, 0.55);

  await jpost('/api/player/command', { action: 'toggleShuffle' });
  const s2 = await jget<{ player: { shuffle: boolean } }>('/api/state');
  assert.equal(s2.player.shuffle, true);
});

test('Неизвестная команда возвращает понятную ошибку', async () => {
  const r = await jpost<{ status: number; error?: string }>('/api/player/command', { action: 'нет-такой' });
  assert.equal(r.status, 400);
  assert.match(r.error || '', /Неизвестная команда/);
});

test('playTrack несуществующего трека → ошибка', async () => {
  const r = await jpost<{ status: number; error?: string }>('/api/player/command', { action: 'playTrack', payload: { trackId: 'нет' } });
  assert.equal(r.status, 400);
  assert.match(r.error || '', /не найден/i);
});

test('Сценический вывод без Electron возвращает понятную ошибку', async () => {
  const r = await jpost<{ status: number; error?: string }>('/api/stage/command', { action: 'play' });
  assert.equal(r.status, 400);
  assert.ok((r.error || '').length > 10, 'сообщение об ошибке должно быть понятным');
});

test('Эквалайзер сохраняет gains и пресеты', async () => {
  const r = await fetch(url('/api/equalizer'), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true, gains: [1, 2, 3, 0, 0, 0, -1, -2, -3, 0] })
  });
  assert.equal(r.status, 200);
  const body = await r.json() as { eq: { enabled: boolean; gains: number[] } };
  assert.equal(body.eq.enabled, true);
  assert.equal(body.eq.gains[2], 3);
});

test('Медиа-стриминг блокирует путь вне разрешённых каталогов', async () => {
  const r = await fetch(url('/api/media/file?path=' + encodeURIComponent('/etc/passwd')));
  assert.equal(r.status, 403);
  const r2 = await fetch(url('/api/media/file?path=' + encodeURIComponent(dataDir + '/../../etc/shadow')));
  assert.ok([403, 404].includes(r2.status));
});

test('Разрешённые каталоги отдаются стримингом с Range', async () => {
  // Создаём аудиофайл в одной из папок настроек и добавляем в библиотеку
  const fsMod = await import('fs');
  const musicDir = path.join(dataDir, 'mymusic');
  fsMod.mkdirSync(musicDir, { recursive: true });
  // минимальный wav
  const buf = Buffer.alloc(44 + 800);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + 800, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(8000, 24); buf.writeUInt32LE(16000, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(800, 40);
  for (let i = 0; i < 400; i++) buf.writeInt16LE(5000, 44 + i * 2);
  const wavPath = path.join(musicDir, 'test.wav');
  fsMod.writeFileSync(wavPath, buf);

  // Регистрируем папку — именно из разрешённых каталогов разрешён стриминг
  await fetch(url('/api/settings'), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ musicFolders: [musicDir] })
  });
  await jpost('/api/music/files', { paths: [wavPath] });
  const tracks = await jget<{ tracks: { id: string }[] }>('/api/music/tracks');
  assert.equal(tracks.tracks.length, 1);
  const id = tracks.tracks[0].id;

  // Полный ответ
  const full = await fetch(url(`/api/media/audio/${id}`));
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('accept-ranges'), 'bytes');

  // Range-запрос
  const range = await fetch(url(`/api/media/audio/${id}`), { headers: { Range: 'bytes=0-99' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), `bytes 0-99/${44 + 800}`);
  const part = await range.arrayBuffer();
  assert.equal(part.byteLength, 100);
});

test('Soundboard: конфигурация, добавление бинарного звука, триггер', async () => {
  const cfg = await jget<{ config: { sets: unknown[]; buttons: unknown[] } }>('/api/soundboard');
  assert.equal(cfg.status, 200);
  assert.ok(cfg.config.sets.length >= 1);

  // Загрузка WAV-байтов
  const wav = Buffer.alloc(64, 7);
  const up = await fetch(url('/api/soundboard/upload?name=' + encodeURIComponent('drum.wav')), {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array(wav)
  });
  assert.equal(up.status, 200);
  const upBody = await up.json() as { button: { id: string } };
  assert.ok(upBody.button.id);

  const trig = await jpost('/api/soundboard/trigger', { buttonId: upBody.button.id });
  assert.equal(trig.status, 200);

  const stop = await jpost('/api/soundboard/stop-all');
  assert.equal(stop.status, 200);
});

test('Плейлисты: создание, добавление треков, удаление', async () => {
  const created = await jpost<{ playlist: { id: string; name: string } }>('/api/playlists', { name: 'Тест' });
  assert.equal(created.status, 200);
  const id = created.playlist.id;
  const upd = await fetch(url(`/api/playlists/${id}`), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Тест 2' })
  });
  assert.equal(upd.status, 200);
  const del = await fetch(url(`/api/playlists/${id}`), { method: 'DELETE' });
  assert.equal(del.status, 200);
});

test('Настройки: LAN по умолчанию выключен, фейды сохраняются', async () => {
  const s = await jget<{ settings: { lanEnabled: boolean; defaults: { fadeIn: number } } }>('/api/settings');
  assert.equal(s.settings.lanEnabled, false);
  const put = await fetch(url('/api/settings'), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ defaults: { fadeIn: 3.5, fadeOut: 2 } })
  });
  assert.equal(put.status, 200);
  const s2 = await jget<{ settings: { defaults: { fadeIn: number; fadeOut: number } } }>('/api/settings');
  assert.equal(s2.settings.defaults.fadeIn, 3.5);
  assert.equal(s2.settings.defaults.fadeOut, 2);
});

test('Быстрый режим: конфиг по умолчанию выключен, включение и валидация плиток', async () => {
  const def = await jget<{ config: { enabled: boolean; tiles: { kind: string; action?: string }[] } }>('/api/quick');
  assert.equal(def.status, 200);
  assert.equal(def.config.enabled, false);
  assert.ok(Array.isArray(def.config.tiles));
  assert.ok(def.config.tiles.some(t => t.kind === 'action'), 'в стартовом наборе есть действия плеера');

  // Включаем и сохраняем набор: корректная плитка + мусорные отбрасываются
  const put = await jput<{ config: { enabled: boolean; tiles: { kind: string; size: string; action?: string }[] } }>('/api/quick', {
    enabled: true,
    tiles: [
      { kind: 'action', size: 'm', action: 'playPause' },
      { kind: 'section', size: 's', section: 'stageBlack' },
      { kind: 'action', size: 's', action: 'неизвестное-действие' },
      { kind: 'track', size: 's' },
      { kind: 'bogus', size: 's' }
    ]
  });
  assert.equal(put.status, 200);
  assert.equal(put.config.enabled, true);
  assert.equal(put.config.tiles.length, 2);
  assert.equal(put.config.tiles[0].action, 'playPause');

  // Конфигурация переживает повторное чтение (сохранение на диск)
  const again = await jget<{ config: { enabled: boolean; tiles: unknown[] } }>('/api/quick');
  assert.equal(again.config.enabled, true);
  assert.equal(again.config.tiles.length, 2);

  // Некорректный размер приводится к 's'
  const put2 = await jput<{ config: { tiles: { size: string }[] } }>('/api/quick', {
    enabled: true,
    tiles: [{ kind: 'action', size: 'огромный', action: 'stop' }]
  });
  assert.equal(put2.status, 200);
  assert.equal(put2.config.tiles[0].size, 's');

  // Выключаем обратно
  await jput('/api/quick', { enabled: false, tiles: [] });
  const fin = await jget<{ config: { enabled: boolean } }>('/api/quick');
  assert.equal(fin.config.enabled, false);
});

test('Картинки для сцены: добавление, скан, стриминг, показ на экране', async () => {
  // Готовим папку с двумя PNG (валидный 1x1 пиксель)
  const imgDir = path.join(dataDir, 'mypics');
  fs.mkdirSync(imgDir, { recursive: true });
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64');
  const picA = path.join(imgDir, 'backdrop.png');
  const picB = path.join(imgDir, 'инфо.jpg');
  fs.writeFileSync(picA, png);
  fs.writeFileSync(picB, png);

  // Папка — в настройки, затем файлы через проводник
  await fetch(url('/api/settings'), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageFolders: [imgDir] })
  });
  const add = await jpost<{ added: number; updated: number; errors: string[] }>('/api/images/files', { paths: [picA, picA] });
  assert.equal(add.status, 200);
  assert.equal(add.added, 1, 'дубликат не добавляется второй раз');
  assert.equal(add.updated, 1);

  // Скан папки находит второй файл
  const scan = await jpost<{ added: number; errors: string[] }>('/api/images/scan', {});
  assert.equal(scan.status, 200);
  assert.equal(scan.added, 1);

  const list = await jget<{ images: { id: string; title: string }[] }>('/api/images');
  assert.equal(list.images.length, 2);
  const id = list.images.find(i => i.title === 'backdrop')!.id;

  // Стриминг из папки библиотеки разрешён
  const media = await fetch(url(`/api/media/image/${id}`));
  assert.equal(media.status, 200);

  // Чужой id → 404
  const nope = await fetch(url('/api/media/image/не-существует'));
  assert.equal(nope.status, 404);

  // Показ на сцене и скрытие
  const show = await jpost<{ ok: boolean }>('/api/stage/command', { action: 'showImage', payload: { imageId: id } });
  assert.equal(show.status, 200);
  const st1 = await jget<{ stage: { imageId: string | null; imageTitle: string } }>('/api/state');
  assert.equal(st1.stage.imageId, id);
  assert.equal(st1.stage.imageTitle, 'backdrop');

  const hide = await jpost<{ ok: boolean }>('/api/stage/command', { action: 'hideImage' });
  assert.equal(hide.status, 200);
  const st2 = await jget<{ stage: { imageId: string | null; blacked: boolean } }>('/api/state');
  assert.equal(st2.stage.imageId, null);
  assert.equal(st2.stage.blacked, true, 'после скрытия картинки — чёрный экран');

  // Несуществующая картинка → понятная ошибка
  const bad = await jpost<{ status: number; error?: string }>('/api/stage/command', { action: 'showImage', payload: { imageId: 'нет' } });
  assert.equal(bad.status, 400);
  assert.match(bad.error || '', /не найдена/i);

  // Скрытие без показанной картинки → ошибка
  const hideAgain = await jpost<{ status: number }>('/api/stage/command', { action: 'hideImage' });
  assert.equal(hideAgain.status, 400);

  // Удаление из списка
  const del = await fetch(url(`/api/images/${id}`), { method: 'DELETE' });
  assert.equal(del.status, 200);
  const list2 = await jget<{ images: unknown[] }>('/api/images');
  assert.equal(list2.images.length, 1);
});

test('Резервная копия содержит конфигурации', async () => {
  const r = await fetch(url('/api/system/backup'));
  assert.equal(r.status, 200);
  const body = await r.json() as { kind: string; settings: unknown; soundboard: unknown; quick: { tiles: unknown[] } | undefined };
  assert.equal(body.kind, 'sonic-studio-backup');
  assert.ok(body.settings);
  assert.ok(body.soundboard);
  assert.ok(Array.isArray(body.quick?.tiles), 'быстрый режим включён в резервную копию');
});

test('Журнал событий отдаётся', async () => {
  const r = await jget<{ logs: string }>('/api/system/logs');
  assert.equal(r.status, 200);
  assert.ok(typeof r.logs === 'string');
});
