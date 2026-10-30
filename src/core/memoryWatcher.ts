import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { log } from '../log';

/**
 * Detects restarts triggered by `max_memory_restart`.
 *
 * PM2 emits NOTHING distinguishable on the bus for these: lib/Worker.js calls
 * God.reloadProcessId() directly, so the resulting traffic is identical to any other
 * reload. The only signal anywhere is a line the daemon writes to its own log.
 *
 * That makes this detection best-effort by nature - it is tied to a log string, not an
 * API, and a PM2 release could change it. So it is opt-in, it never throws, and if the
 * format changes the result is silence rather than wrong alerts.
 */

const LINE =
  /\[PM2\]\[WORKER\] Process (\d+) restarted because it exceeds --max-memory-restart value \(current_memory=(\d+) max_memory_limit=(\d+)/;

export interface MemoryRestart {
  pmId: number;
  currentMemory: number;
  limit: number;
}

export function parseMemoryRestartLine(line: string): MemoryRestart | null {
  const m = LINE.exec(line);
  if (!m) return null;
  return {
    pmId: parseInt(m[1] as string, 10),
    currentMemory: parseInt(m[2] as string, 10),
    limit: parseInt(m[3] as string, 10),
  };
}

export function defaultPm2LogPath(): string {
  return join(process.env.PM2_HOME ?? join(homedir(), '.pm2'), 'pm2.log');
}

export class MemoryRestartWatcher {
  private offset = 0;
  private primed = false;

  constructor(private readonly path: string) {}

  /**
   * Returns restarts seen since the last call. The first call only records the current
   * end of the file - we must not alert on history written before the module started.
   */
  async poll(): Promise<MemoryRestart[]> {
    let size: number;
    try {
      size = (await stat(this.path)).size;
    } catch {
      return []; // log missing - nothing to do, and not worth complaining about
    }

    if (!this.primed) {
      this.offset = size;
      this.primed = true;
      return [];
    }

    // Log rotation or truncation: start again from the beginning of the new file.
    if (size < this.offset) this.offset = 0;
    if (size === this.offset) return [];

    const length = size - this.offset;
    let handle;
    try {
      handle = await open(this.path, 'r');
    } catch {
      return [];
    }
    try {
      const buf = Buffer.alloc(Math.min(length, 1024 * 1024));
      const { bytesRead } = await handle.read(buf, 0, buf.length, this.offset);
      this.offset += bytesRead;
      const out: MemoryRestart[] = [];
      for (const line of buf.subarray(0, bytesRead).toString('utf8').split('\n')) {
        const hit = parseMemoryRestartLine(line);
        if (hit) out.push(hit);
      }
      return out;
    } catch (err) {
      log.debug('memory restart watcher read failed', { error: (err as Error).message });
      return [];
    } finally {
      await handle.close().catch(() => undefined);
    }
  }
}
