import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { startSonicServer, RunningServer } from '../dist/server/index';
import { DeviceManager } from '../dist/server/devices';
import { ensurePaths, resolveDataDir } from '../dist/server/paths';

/**
 * Тесты реестра устройств вывода: автосоздание при входе на сайт,
 * сохранение на диск, подключение по коду (PIN), переименование, удаление.
 */

let server: RunningServer;
let dataDir: string;
let pin: string;

function url(p: string): string {
  return `http://127.0.0.1:${server.port}${p}`;
}

async function jpost<T>(p: string, body?: unknown, ua?: string): Promise<{ status: number } & T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (ua) headers['User-Agent'] = ua;
  const r = await fetch(url(p), {
    method: 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const json = await r.json() as Record<string, unknown>;
  return Object.assign({ status: r.status }, json) as { status: number } & T;
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonic-devices-'));
  server = await startSonicServer({ dataDir, port: 0, electron: false, appVersion: 'test' });
  pin = server.ctx.settings.data.lanPin;
});

after(async () => {
  await server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// ─── Автосоздание при входе на сайт (как на реальном телефоне) ───

test('вход на сайт с deviceId автоматически создаёт и сохраняет устройство', async () => {
  const r = await jpost<{ ok: boolean; token: string }>('/api/auth/login', {
    pin,
    deviceId: 'dev-phone-1'
  }, 'Mozilla/5.0 (Linux; Android 13; SM-A536B) Mobile Safari/537.36');
  assert.equal(r.status, 200);
  assert.ok(r.token);

  const list = await fetch(url('/api/devices')).then(x => x.json()) as {
    devices: Array<{ id: string; name: string; type: string; paired: boolean; online: boolean }>;
  };
  const d = list.devices.find(x => x.id === 'dev-phone-1');
  assert.ok(d, 'устройство появилось в списке');
  assert.equal(d!.type, 'phone');
  assert.equal(d!.paired, false);

  // Сохранено на диск (flush отложенной записи)
  server.ctx.devices.saveNow();
  const paths = ensurePaths(resolveDataDir(dataDir));
  const raw = JSON.parse(fs.readFileSync(path.join(paths.settings, 'devices.json'), 'utf8')) as { devices: Array<{ id: string }> };
  assert.ok(raw.devices.some(x => x.id === 'dev-phone-1'));
});

// ─── Подключение по коду ───

test('pair: неверный код отклоняется, верный — подключает и сохраняет', async () => {
  const wrong = await jpost<{ error?: string }>('/api/devices/pair', { id: 'dev-phone-1', pin: '000000' });
  assert.equal(wrong.status, 400);

  const ok = await jpost<{ ok: boolean; device: { paired: boolean } }>('/api/devices/pair', { id: 'dev-phone-1', pin });
  assert.equal(ok.status, 200);
  assert.equal(ok.device.paired, true);

  server.ctx.devices.saveNow();
  const paths = ensurePaths(resolveDataDir(dataDir));
  const raw = JSON.parse(fs.readFileSync(path.join(paths.settings, 'devices.json'), 'utf8')) as { devices: Array<{ id: string; paired: boolean }> };
  assert.ok(raw.devices.find(x => x.id === 'dev-phone-1')?.paired);
});

test('pair несуществующего устройства — понятная ошибка', async () => {
  const r = await jpost<{ error?: string }>('/api/devices/pair', { id: 'dev-ghost', pin });
  assert.equal(r.status, 400);
  assert.match(String(r.error), /не найдено|Откройте сайт/i);
});

test('output: без пары — отказ (400), с парой но не в сети — 409', async () => {
  // Второе устройство: создаём и НЕ подключаем
  await jpost('/api/auth/login', { pin, deviceId: 'dev-phone-2' }, 'Mozilla/5.0 (iPad; CPU OS 17_0)');
  const r1 = await jpost<{ error?: string }>('/api/devices/dev-phone-2/output', {});
  assert.equal(r1.status, 400);

  // Подключаем — но устройство не в сети (нет WS-соединения) → 409
  await jpost('/api/devices/pair', { id: 'dev-phone-2', pin });
  const r2 = await jpost<{ error?: string }>('/api/devices/dev-phone-2/output', {});
  assert.equal(r2.status, 409);
});

// ─── Переименование / забыть ───

test('rename и unpair работают через API', async () => {
  const rn = await jpost<{ ok: boolean; device: { name: string } }>('/api/devices/dev-phone-1/rename', { name: 'ТВ в зале' });
  assert.equal(rn.status, 200);
  assert.equal(rn.device.name, 'ТВ в зале');

  const up = await jpost<{ ok: boolean; device: { paired: boolean } }>('/api/devices/dev-phone-2/unpair', {});
  assert.equal(up.status, 200);
  assert.equal(up.device.paired, false);
});

test('remove удаляет устройство из списка', async () => {
  const r = await fetch(url('/api/devices/dev-phone-2'), { method: 'DELETE' });
  assert.equal(r.status, 200);
  const list = await fetch(url('/api/devices')).then(x => x.json()) as { devices: Array<{ id: string }> };
  assert.ok(!list.devices.some(d => d.id === 'dev-phone-2'));
});

// ─── DeviceManager напрямую: имена, восстановление после перезапуска ───

test('повторный touch не создаёт дубликат, имена устройств уникальны', () => {
  const paths = ensurePaths(resolveDataDir(dataDir));
  const mgr = new DeviceManager(paths, () => pin);
  const a = mgr.touch('dev-x', { ua: 'Mozilla/5.0 (Android 13; Tablet)', ip: '10.0.0.1' });
  const first = mgr.byId('dev-x')!;
  mgr.touch('dev-x', { ua: 'Mozilla/5.0 (Android 13; Tablet)', ip: '10.0.0.1' });
  assert.equal(mgr.list().filter(d => d.id === 'dev-x').length, 1);
  assert.ok(mgr.byId('dev-x')!.lastSeen >= first.lastSeen);

  const b = mgr.touch('dev-y', { ua: 'Mozilla/5.0 (Android 13; Tablet)', ip: '10.0.0.2' });
  assert.notEqual(a.name, b.name, 'одинаковые устройства получают разные имена');
  mgr.saveNow();
});

test('реестр восстанавливается после «перезапуска» (новый экземпляр читает файл)', () => {
  server.ctx.devices.saveNow(); // flush последнего переименования
  const paths = ensurePaths(resolveDataDir(dataDir));
  const mgr = new DeviceManager(paths, () => pin);
  const d = mgr.byId('dev-phone-1');
  assert.ok(d, 'устройство найдено после перезапуска');
  assert.equal(d!.name, 'ТВ в зале');
  assert.equal(d!.paired, true);
});
