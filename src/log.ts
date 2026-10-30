/** Structured JSON logging. One line per state transition; never per successful tick. */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold: number = ORDER.info;

export function setLogLevel(level: LogLevel): void {
  threshold = ORDER[level] ?? ORDER.info;
}

function write(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
  if (ORDER[level] < threshold) return;
  const line = { ts: new Date().toISOString(), level, mod: 'pm2-alertmanager', msg, ...fields };
  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  try {
    out.write(JSON.stringify(line) + '\n');
  } catch {
    // Logging must never be able to take the module down (NFR-2).
  }
}

export const log = {
  debug: (m: string, f?: Record<string, unknown>) => write('debug', m, f),
  info:  (m: string, f?: Record<string, unknown>) => write('info', m, f),
  warn:  (m: string, f?: Record<string, unknown>) => write('warn', m, f),
  error: (m: string, f?: Record<string, unknown>) => write('error', m, f),
};

/** Log a given key at most once for the lifetime of the process. */
const seen = new Set<string>();
export function logOnce(key: string, level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
  if (seen.has(key)) return;
  seen.add(key);
  write(level, msg, fields);
}
