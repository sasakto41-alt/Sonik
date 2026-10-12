import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeResolve, LoginGuard } from '../dist/server/security';
import * as os from 'os';
import * as path from 'path';

test('safeResolve: принимает путь внутри разрешённого корня', () => {
  const root = os.tmpdir();
  const p = path.join(root, 'music', 'song.mp3');
  const r = safeResolve([root], p);
  assert.ok(r, 'путь должен быть разрешён');
  assert.equal(r, path.resolve(p));
});

test('safeResolve: блокирует обход каталогов (..)', () => {
  const root = path.join(os.tmpdir(), 'allowed-root');
  const p = path.join(root, '..', 'secret.txt');
  assert.equal(safeResolve([root], p), null);
});

test('safeResolve: блокирует абсолютные пути вне корней', () => {
  const root = path.join(os.tmpdir(), 'allowed-root2');
  assert.equal(safeResolve([root], '/etc/passwd'), null);
  assert.equal(safeResolve([root], 'C:\\Windows\\system32\\config.sys'), null);
});

test('safeResolve: блокирует пустые пути и null-байты', () => {
  const root = os.tmpdir();
  assert.equal(safeResolve([root], ''), null);
  assert.equal(safeResolve([root], 'file\0.txt'), null);
});

test('safeResolve: принимает вложенные корни и сам корень', () => {
  const root = path.join(os.tmpdir(), 'root3');
  assert.ok(safeResolve([root], root));
  assert.ok(safeResolve([root], path.join(root, 'a', 'b', 'c.mp3')));
});

test('LoginGuard: блокировка после 5 неудачных попыток', () => {
  const guard = new LoginGuard();
  const ip = '192.168.1.55';
  for (let i = 0; i < 5; i++) {
    assert.ok(guard.canAttempt(ip).ok);
    guard.fail(ip);
  }
  const attempt = guard.canAttempt(ip);
  assert.equal(attempt.ok, false);
  assert.ok(attempt.retryAfterSec > 0);
  guard.reset(ip);
  assert.ok(guard.canAttempt(ip).ok);
});
