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

function format(fmt: string, args: unknown[]): string {
  let i = 0;
  return fmt.replace(/%[sdjoO%]/g, (m) => {
    if (m === '%%') return '%';
    if (i >= args.length) return m;
    const arg = args[i++];
    switch (m) {
      case '%s': return String(arg);
      case '%d': return Number(arg).toString();
      case '%j':
      case '%o':
      case '%O': return JSON.stringify(arg);
      default: return m;
    }
  });
}

export function createLogger(module: string): Logger {
  function write(level: LogLevel, fmt: string, args: unknown[]): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return;
    const ts = new Date().toISOString().slice(11, 23);
    const msg = args.length > 0 ? format(fmt, args) : fmt;
    try {
      // stderr only: stdout is the binary wire pipe under the stdio carrier
      // (xacpp 1.x frame protocol); any log byte on stdout corrupts frames.
      process.stderr.write(`[${ts}] [${level.toUpperCase().padEnd(5)}] [${module}] ${msg}\n`);
    } catch {
      // EPIPE: pipe closed (e.g. parent process exited), silently ignore
    }
  }

  return {
    debug: (fmt, ...args) => write('debug', fmt, args),
    info: (fmt, ...args) => write('info', fmt, args),
    warn: (fmt, ...args) => write('warn', fmt, args),
    error: (fmt, ...args) => write('error', fmt, args),
  };
}

/**
 * stderr-only logger shaped for third-party SDKs (e.g. @larksuiteoapi/node-sdk)
 * that accept a `logger` injection. SDK defaults print to stdout via console.*,
 * which corrupts the binary wire pipe under the stdio carrier — always inject
 * this at SDK construction sites.
 */
export const sdkStderrLogger = {
  error: (...msg: unknown[]) => { process.stderr.write(`[sdk-err] ${JSON.stringify(msg)}\n`); },
  warn: (...msg: unknown[]) => { process.stderr.write(`[sdk-warn] ${JSON.stringify(msg)}\n`); },
  info: (...msg: unknown[]) => { process.stderr.write(`[sdk-info] ${JSON.stringify(msg)}\n`); },
  debug: (...msg: unknown[]) => { process.stderr.write(`[sdk-debug] ${JSON.stringify(msg)}\n`); },
  trace: (...msg: unknown[]) => { process.stderr.write(`[sdk-trace] ${JSON.stringify(msg)}\n`); },
};
