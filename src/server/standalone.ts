import { startSonicServer } from './index';

// Фоновые ошибки не должны убивать сервер: логируем и продолжаем.
process.on('uncaughtException', (err) => {
  console.error('[Sonic] Ошибка перехвачена, сервер продолжает работать:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Sonic] Отклонение обещания перехвачено, сервер продолжает работать:', reason);
});

/**
 * Запуск сервера Sonic Studio без Electron (режим разработки/тестирования).
 * Использует: node dist/server/standalone.js [--port N] [--data-dir PATH]
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let port: number | undefined;
  let dataDir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port') port = Number(args[++i]);
    else if (args[i] === '--data-dir') dataDir = args[++i];
  }

  try {
    const server = await startSonicServer({ dataDir, port, electron: false });
    console.log('');
    console.log('  Sonic Studio (сервер без Electron)');
    console.log(`  Локально:    ${server.url}`);
    console.log(`  Данные:      ${server.ctx.paths.root}`);
    console.log('  Остановка:   Ctrl+C');
    console.log('');
  } catch (err) {
    console.error('Не удалось запустить сервер: ' + (err as Error).message);
    process.exit(1);
  }

  const shutdown = async (signal: string) => {
    console.log(`\nПолучен сигнал ${signal}, останавливаем сервер...`);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main();
