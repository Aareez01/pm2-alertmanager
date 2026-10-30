import { writeFileSync, renameSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { log } from '../log';

/**
 * Persisted alert state.
 *
 * Without this, restarting the module re-alerts every active incident and loses the
 * resolution tracking for them - and the module restarts itself every time `pm2 set`
 * changes its configuration, so this is a routine event rather than a rare one.
 *
 * Written atomically (temp file + rename) so a crash mid-write cannot leave a truncated
 * file that fails to parse on the next boot.
 */

export interface PersistedState {
  version: 1;
  savedAt: number;
  suppressor: Record<string, unknown>;
  active: [string, { firstAt: number; lastAt: number; severity: string; kind: string;
    app: string; pmIds: number[] }][];
}

export function defaultStatePath(): string {
  const base = process.env.PM2_HOME ?? join(homedir(), '.pm2');
  return join(base, 'pm2-alertmanager-state.json');
}

export function loadState(path: string): PersistedState | null {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as PersistedState;
    if (parsed?.version !== 1) return null;
    return parsed;
  } catch (err) {
    // Corrupt state must not stop the module booting - start clean and say so.
    log.warn('could not read persisted state, starting clean', {
      path, error: (err as Error).message,
    });
    return null;
  }
}

export function saveState(path: string, state: PersistedState): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), 'utf8');
    renameSync(tmp, path);
  } catch (err) {
    log.warn('could not persist state', { path, error: (err as Error).message });
  }
}
