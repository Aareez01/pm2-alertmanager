import { describe, it, expect } from 'vitest';
import { writeFileSync, appendFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseMemoryRestartLine, MemoryRestartWatcher } from '../../src/core/memoryWatcher';

// Copied verbatim from PM2 7.1.1 lib/Worker.js, with the format args filled in. This is
// the ONLY signal PM2 produces for a memory-triggered restart - nothing reaches the bus.
const REAL_LINE =
  '2026-10-30T17:00:00: [PM2][WORKER] Process 3 restarted because it exceeds ' +
  '--max-memory-restart value (current_memory=215678976 max_memory_limit=209715200 [octets])';

describe('parseMemoryRestartLine', () => {
  it('parses the real PM2 worker line', () => {
    expect(parseMemoryRestartLine(REAL_LINE)).toEqual({
      pmId: 3, currentMemory: 215678976, limit: 209715200,
    });
  });

  it('ignores every other daemon log line', () => {
    for (const l of [
      '2026-10-30: [PM2][WORKER] Started',
      'App [api:1] starting in -cluster mode-',
      '[PM2][WORKER] Process 3 restarted for some other reason',
      '',
    ]) expect(parseMemoryRestartLine(l)).toBeNull();
  });
});

describe('MemoryRestartWatcher', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pm2am-'));
  const file = join(dir, 'pm2.log');

  it('ignores pre-existing history on the first poll', async () => {
    writeFileSync(file, REAL_LINE + '\n');
    const w = new MemoryRestartWatcher(file);
    // Must not alert about restarts that happened before this module started.
    expect(await w.poll()).toEqual([]);
  });

  it('reports lines appended after priming', async () => {
    writeFileSync(file, 'old stuff\n');
    const w = new MemoryRestartWatcher(file);
    await w.poll();
    appendFileSync(file, REAL_LINE + '\n');
    const hits = await w.poll();
    expect(hits).toHaveLength(1);
    expect(hits[0]!.pmId).toBe(3);
  });

  it('returns nothing when the file has not grown', async () => {
    writeFileSync(file, 'x\n');
    const w = new MemoryRestartWatcher(file);
    await w.poll();
    expect(await w.poll()).toEqual([]);
  });

  it('recovers from log rotation instead of going silent forever', async () => {
    writeFileSync(file, 'a'.repeat(500) + '\n');
    const w = new MemoryRestartWatcher(file);
    await w.poll();
    writeFileSync(file, REAL_LINE + '\n');   // rotated: smaller than our offset
    const hits = await w.poll();
    expect(hits).toHaveLength(1);
  });

  it('does not throw when the log does not exist', async () => {
    const w = new MemoryRestartWatcher(join(dir, 'nope.log'));
    expect(await w.poll()).toEqual([]);
    expect(await w.poll()).toEqual([]);
  });

  it('picks up several restarts written in one burst', async () => {
    writeFileSync(file, '\n');
    const w = new MemoryRestartWatcher(file);
    await w.poll();
    appendFileSync(file, REAL_LINE + '\n' + REAL_LINE.replace('Process 3', 'Process 7') + '\n');
    const hits = await w.poll();
    expect(hits.map((h) => h.pmId)).toEqual([3, 7]);
  });
});
