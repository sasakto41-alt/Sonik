import * as net from 'net';

/** Проверяет, свободен ли порт на хосте. */
export function isPortFree(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, host);
  });
}
