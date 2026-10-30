import { describe, it, expect } from 'vitest';
import { Detector } from '../../src/core/detector';
import { NormalizedEvent } from '../../src/events/normalize';

const ev = (over: Partial<NormalizedEvent> = {}): NormalizedEvent => ({
  kind: 'exit', app: 'api', pmId: 1, status: 'stopped', exitCode: 1,
  at: 1_000_000, ...over,
});

const opts = { restartWindowMs: 30_000, crashLoopThreshold: 3, crashLoopWindowMs: 60_000 };

describe('exit deduplication (REQ-AM-02a)', () => {
  it('ignores the status=stopping half of every exit pair', () => {
    const d = new Detector(opts);
    expect(d.ingest(ev({ status: 'stopping' }), 1000)).toEqual([]);
  });

  it('counts one restart as ONE exit, not two', () => {
    const d = new Detector(opts);
    // Three full restarts = six raw exit events. Naive counting would trip the
    // crash-loop threshold of 3 after only 1.5 restarts.
    let loops = 0;
    for (let i = 0; i < 2; i++) {
      d.ingest(ev({ status: 'stopping' }), 1000 + i * 100);
      const out = d.ingest(ev({ status: 'stopped' }), 1000 + i * 100);
      loops += out.filter((c) => c.kind === 'crash-loop').length;
    }
    expect(loops).toBe(0); // two real exits, threshold is three
    const out = d.ingest(ev({ status: 'stopped' }), 1300);
    expect(out.filter((c) => c.kind === 'crash-loop')).toHaveLength(1);
  });
});

describe('condition derivation (REQ-AM-03)', () => {
  it('a non-zero exit code is a crash, reported immediately', () => {
    const d = new Detector(opts);
    const out = d.ingest(ev({ exitCode: 1 }), 1000);
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('crash');
    expect(out[0]!.severity).toBe('warning');
  });

  it('a clean exit followed by a start is a restart, not a stop', () => {
    const d = new Detector(opts);
    expect(d.ingest(ev({ exitCode: 0 }), 1000)).toEqual([]);   // ambiguous, deferred
    const out = d.ingest(ev({ kind: 'online', exitCode: 0 }), 2000);
    expect(out[0]!.kind).toBe('restart');
    expect(d.tick(100_000)).toEqual([]);                        // nothing left pending
  });

  it('a clean exit that never comes back is an operator stop', () => {
    const d = new Detector(opts);
    d.ingest(ev({ exitCode: 0 }), 1000);
    expect(d.tick(1000 + 29_000)).toEqual([]);                  // still inside the window
    const out = d.tick(1000 + 31_000);
    expect(out[0]!.kind).toBe('operator-stop');
    expect(out[0]!.severity).toBe('info');
  });

  it("'restart overlimit' is an immediate crash loop", () => {
    const d = new Detector(opts);
    const out = d.ingest(ev({ kind: 'restart-overlimit' }), 1000);
    expect(out[0]!.kind).toBe('crash-loop');
    expect(out[0]!.severity).toBe('critical');
    expect(d.isInCrashLoop('api', 1)).toBe(true);
  });

  it('reports a crash loop only once while it continues', () => {
    const d = new Detector(opts);
    let loops = 0;
    for (let i = 0; i < 50; i++) {
      loops += d.ingest(ev(), 1000 + i).filter((c) => c.kind === 'crash-loop').length;
    }
    expect(loops).toBe(1);
  });
});

describe('the manually flag is never used for classification (REQ-AM-03a)', () => {
  it('a probe-initiated restart still produces an alert', () => {
    const d = new Detector(opts);
    // pm2-probe restarts an unhealthy instance. PM2 reports manually=true because the
    // call came through the API - suppressing on that flag would hide the failure.
    const out = d.ingest({
      kind: 'probe-status', app: 'api', pmId: 1, at: 1000,
      probe: {
        v: 1, state: 'fail', app: 'api', pm_id: 1, probe: 'http',
        probe_kind: 'liveness', at: '2026-10-30T00:00:00.000Z',
        reason: 'status 503', action: 'restart',
      },
    }, 1000);
    expect(out[0]!.kind).toBe('probe-fail');
    expect(out[0]!.severity).toBe('critical');
  });

  it('classifies identically whether manually is true or false', () => {
    const a = new Detector(opts).ingest(ev({ manuallyFlag: true }), 1000);
    const b = new Detector(opts).ingest(ev({ manuallyFlag: false }), 1000);
    expect(a[0]!.kind).toBe(b[0]!.kind);
    expect(a[0]!.severity).toBe(b[0]!.severity);
  });
});
