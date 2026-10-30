import { open } from 'node:fs/promises';

/**
 * Reads the last N lines of a log file.
 *
 * Deliberately NOT done by subscribing to the `log:err` bus and keeping a ring buffer:
 * that costs memory proportional to total log throughput across every app on the host,
 * for data we need only in the rare moment an alert fires. We read from the file PM2
 * already wrote, on demand, from the end.
 */

const CHUNK = 16 * 1024;
const MAX_BYTES = 512 * 1024;

export async function tailLines(path: string, lines: number): Promise<string[]> {
  if (!path || lines <= 0) return [];
  let handle;
  try {
    handle = await open(path, 'r');
  } catch {
    return []; // log file missing or unreadable - not worth failing an alert over
  }
  try {
    const { size } = await handle.stat();
    if (size === 0) return [];

    let pos = size;
    let buf = Buffer.alloc(0);
    let found = 0;

    while (pos > 0 && found <= lines && buf.length < MAX_BYTES) {
      const len = Math.min(CHUNK, pos);
      pos -= len;
      const chunk = Buffer.alloc(len);
      await handle.read(chunk, 0, len, pos);
      buf = Buffer.concat([chunk, buf]);
      found = 0;
      for (const b of buf) if (b === 0x0a) found++;
    }

    const all = buf.toString('utf8').split('\n');
    while (all.length > 0 && all[all.length - 1] === '') all.pop();
    return all.slice(-lines);
  } catch {
    return [];
  } finally {
    await handle.close().catch(() => undefined);
  }
}
