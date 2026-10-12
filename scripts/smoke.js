/**
 * Smoke-проверка Sonic Studio (без Electron):
 * запускает реальный сервер во временном каталоге и проверяет ключевые сценарии API.
 *
 * Запуск: npm run build && node scripts/smoke.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const results = [];
let ok = 0, fail = 0;

function log(name, status, note = '') {
  results.push(`${status === 'OK' ? '✔' : '✖'} ${name}${note ? ' — ' + note : ''}`);
  if (status === 'OK') ok++; else fail++;
}

async function req(port, method, p, body, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* не JSON */ }
  return { status: res.status, json };
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonic-smoke-'));
  const child = spawn(process.execPath, ['dist/server/standalone.js', '--port', '18799', '--data-dir', dataDir], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const wait = (ms) => new Promise(r => setTimeout(r, ms));

  // Ждём готовности сервера
  let ready = false;
  for (let i = 0; i < 40 && !ready; i++) {
    await wait(250);
    try {
      const r = await fetch('http://127.0.0.1:18799/api/health');
      ready = r.ok;
    } catch { /* ещё не готов */ }
  }

  if (!ready) {
    log('Сервер запустился', 'FAIL', 'health не ответил за 10 с');
  } else {
    log('Сервер запустился', 'OK');

    const health = await req(18799, 'GET', '/api/health');
    log('GET /api/health', health.json && health.json.ok ? 'OK' : 'FAIL');

    const state = await req(18799, 'GET', '/api/state');
    log('GET /api/state (снимок состояния)',
      state.json && state.json.player && state.json.stage && state.json.system ? 'OK' : 'FAIL');
    log('LAN по умолчанию выключен', state.json.system.lanEnabled === false ? 'OK' : 'FAIL',
      JSON.stringify({ lanEnabled: state.json.system.lanEnabled }));

    const vol = await req(18799, 'POST', '/api/player/command', { action: 'setVolume', payload: { volume: 0.7 } });
    const st2 = await req(18799, 'GET', '/api/state');
    log('Команда плеера setVolume применяется', st2.json.player.volume === 0.7 ? 'OK' : 'FAIL');

    const forbidden = await req(18799, 'GET', '/api/media/file?path=' + encodeURIComponent('/etc/passwd'));
    log('Защита от обхода каталогов', forbidden.status === 403 ? 'OK' : 'FAIL', `status=${forbidden.status}`);

    const eq = await req(18799, 'PUT', '/api/equalizer', { enabled: true, gains: [1, 2, 3, 0, 0, 0, 0, 0, 0, 0] });
    log('Эквалайзер сохраняется', eq.status === 200 && eq.json.eq.enabled ? 'OK' : 'FAIL');

    const sb = await req(18799, 'GET', '/api/soundboard');
    log('Soundboard конфигурация', sb.json.config && sb.json.config.sets.length >= 1 ? 'OK' : 'FAIL');

    const stage = await req(18799, 'POST', '/api/stage/command', { action: 'play' });
    log('Сцена без Electron — понятная ошибка', stage.status === 400 && stage.json.error ? 'OK' : 'FAIL');

    const qr = await req(18799, 'GET', '/api/system/qr');
    log('QR/URL отдаётся', qr.json && typeof qr.json.url === 'string' ? 'OK' : 'FAIL');

    const backup = await req(18799, 'GET', '/api/system/backup');
    log('Резервная копия', backup.json && backup.json.kind === 'sonic-studio-backup' ? 'OK' : 'FAIL');

    const index = await fetch('http://127.0.0.1:18799/');
    const html = await index.text();
    log('Веб-интерфейс отдаётся', index.status === 200 && html.includes('Sonic Studio') ? 'OK' : 'FAIL');
    const csp = index.headers.get('content-security-policy');
    log('CSP-заголовок установлен', Boolean(csp) ? 'OK' : 'FAIL');

    const stageHtml = await fetch('http://127.0.0.1:18799/stage.html');
    log('Страница Stage Output отдаётся', stageHtml.status === 200 ? 'OK' : 'FAIL');
  }

  // Остановка сервера: SIGTERM — сервер должен завершиться корректно
  child.kill('SIGTERM');
  await wait(1500);
  const stopped = child.exitCode !== null || child.signalCode !== null;
  log('Сервер корректно останавливается', stopped ? 'OK' : 'FAIL');
  if (!stopped) child.kill('SIGKILL');

  fs.rmSync(dataDir, { recursive: true, force: true });

  console.log('\n=== Sonic Studio — smoke-проверка ===');
  for (const r of results) console.log('  ' + r);
  console.log(`\nИтого: ${ok} успешно, ${fail} с ошибкой\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Smoke-проверка упала:', err);
  process.exit(1);
});
