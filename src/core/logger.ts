import type { LogLevel } from './types.js';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel: LogLevel = 'info';

export function setLevel(level: LogLevel): void {
  currentLevel = level;
}

export interface Logger {
  debug(fmt: string, ...args: unknown[]): void;
  info(fmt: string, ...args: unknown[]): void;
  warn(fmt: string, ...args: unknown[]): void;
  error(fmt: string, ...args: unknown[]): void;
}

export function createLogger(module: string): Logger {
  function write(level: LogLevel, fmt: string, args: unknown[]): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return;
    const ts = new Date().toISOString().slice(11, 23);
    const msg = args.length > 0 ? `${fmt} ${args.map(String).join(' ')}` : fmt;
    process.stdout.write(`[${ts}] [${level.toUpperCase().padEnd(5)}] [${module}] ${msg}\n`);
  }

  return {
    debug: (fmt, ...args) => write('debug', fmt, args),
    info: (fmt, ...args) => write('info', fmt, args),
    warn: (fmt, ...args) => write('warn', fmt, args),
    error: (fmt, ...args) => write('error', fmt, args),
  };
}
