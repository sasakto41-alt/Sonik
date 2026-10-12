import * as fs from 'fs';
import * as path from 'path';

const MAX_LOG_SIZE = 5 * 1024 * 1024;

export class Logger {
  private file: string;

  constructor(logsDir: string) {
    this.file = path.join(logsDir, 'app.log');
  }

  private write(level: string, msg: string): void {
    const line = `[${new Date().toISOString()}] [${level}] ${msg}\n`;
    try {
      if (fs.existsSync(this.file) && fs.statSync(this.file).size > MAX_LOG_SIZE) {
        const rotated = this.file + '.1';
        if (fs.existsSync(rotated)) fs.unlinkSync(rotated);
        fs.renameSync(this.file, rotated);
      }
      fs.appendFileSync(this.file, line);
    } catch {
      /* журнал не должен ломать приложение */
    }
    if (level === 'ERROR') console.error(line.trim());
    else console.log(line.trim());
  }

  info(msg: string): void { this.write('INFO', msg); }
  warn(msg: string): void { this.write('WARN', msg); }
  error(msg: string): void { this.write('ERROR', msg); }

  tail(lines = 200): string {
    try {
      if (!fs.existsSync(this.file)) return '';
      const data = fs.readFileSync(this.file, 'utf8').trimEnd().split('\n');
      return data.slice(-lines).join('\n');
    } catch {
      return '';
    }
  }
}
