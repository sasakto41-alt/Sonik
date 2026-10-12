import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JsonStore } from '../dist/server/store';

interface Cfg { name: string; count: number; nested: { a: number; b: string } }

test('JsonStore: создание с значениями по умолчанию', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonic-store-'));
  const file = path.join(dir, 'cfg.json');
  const store = new JsonStore<Cfg>(file, { name: 'def', count: 0, nested: { a: 1, b: 'x' } }, 10);
  assert.equal(store.data.name, 'def');
  assert.equal(store.data.nested.a, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('JsonStore: сохранение и повторная загрузка', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonic-store-'));
  const file = path.join(dir, 'cfg.json');
  const store = new JsonStore<Cfg>(file, { name: 'def', count: 0, nested: { a: 1, b: 'x' } }, 10);
  store.updateNow((d: Cfg) => {
    d.name = 'тест';
    d.count = 42;
    d.nested.a = 99;
  });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).count, 42);
  const store2 = new JsonStore<Cfg>(file, { name: 'def', count: 0, nested: { a: 1, b: 'x' } }, 10);
  assert.equal(store2.data.name, 'тест');
  assert.equal(store2.data.count, 42);
  assert.equal(store2.data.nested.a, 99);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('JsonStore: дополняет новые поля из defaults (обновление приложения не теряет данные)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonic-store-'));
  const file = path.join(dir, 'cfg.json');
  fs.writeFileSync(file, JSON.stringify({ name: 'старое' }));
  const store = new JsonStore<Cfg>(file, { name: 'def', count: 7, nested: { a: 5, b: 'y' } }, 10);
  assert.equal(store.data.name, 'старое');
  assert.equal(store.data.count, 7);
  assert.equal(store.data.nested.a, 5);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('JsonStore: повреждённый файл не роняет приложение', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonic-store-'));
  const file = path.join(dir, 'cfg.json');
  fs.writeFileSync(file, '{ это не json !!!');
  const store = new JsonStore<Cfg>(file, { name: 'def', count: 1, nested: { a: 1, b: 'x' } }, 10);
  assert.equal(store.data.name, 'def');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('JsonStore: отложенное сохранение выполняется', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonic-store-'));
  const file = path.join(dir, 'cfg.json');
  const store = new JsonStore<Cfg>(file, { name: 'def', count: 0, nested: { a: 1, b: 'x' } }, 20);
  store.update((d: Cfg) => { d.count = 5; });
  await new Promise(r => setTimeout(r, 120));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).count, 5);
  fs.rmSync(dir, { recursive: true, force: true });
});
