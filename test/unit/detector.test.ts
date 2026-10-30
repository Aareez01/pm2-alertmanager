import { describe, it, expect } from 'vitest';
import { Detector, SettledLookup } from '../../src/core/detector';
import { NormalizedEvent } from '../../src/events/normalize';

const ev = (over: Partial<NormalizedEvent> = {}): NormalizedEvent => ({
  kind: 'exit', app: 'api', pmId: 1, status: 'stopped', exitCode: 1,
  at: 1_000_000, ...over,
});

const opts = {
  settleMs: 3_000, restartWindowMs: 30_000,
  crashLoopThreshold: 3, crashLoopWindowMs: 60_000,
};

const autorestartOn: SettledLookup = () => ({ autorestart: true });
const autorestartOff: SettledLookup = () => ({ autorestart: false });

/**
 * One full crash-and-restart cycle as PM2 actually emits it: exit(stopping),
 * exit(stopped), online - then classification settles. Feeding bare exits tests a
 * sequence PM2 never produces.
 */
function crashCycle(d: Detector, t: number, exitCode = 1) {
  d.ingest(ev({ status: 'stopping', exitCode, at: t }), t);
  d.ingest(ev({ status: 'stopped', exitCode, at: t }), t);
  d.ingest(ev({ kind: 'online', at: t + 100 }), t + 100);
  return d.tick(t + 4_000, autorestartOn);
}

describe('exit deduplication', () => {
  it('ignores the status=stopping half of every exit pair', () => {
    expect(new Detector(opts).ingest(ev({ status: 'stopping' }), 1000)).toEqual([]);
  });

  it('counts one restart as ONE crash, not two', () => {
    // Each restart emits two exits. Counting both would trip a threshold of 3 after
    // only one and a half restarts.
    const d = new Detector(opts);
    expect(crashCycle(d, 10_000).map((c) => c.kind)).toEqual(['crash']);
    expect(crashCycle(d, 20_000).map((c) => c.kind)).toEqual(['crash']);
    // Third crash, not sixth exit, is what escalates.
    expect(crashCycle(d, 30_000).map((c) => c.kind)).toEqual(['crash-loop']);
  });

  it('a requested restart is not a crash and never escalates to a loop', () => {
    // `pm2 set` restarts a module. A few config changes must not look like an app
    // dying repeatedly - this produced a false crash-loop page in the lab.
    const d = new Detector(opts);
    for (let i = 0; i < 6; i++) {
      const t = 10_000 + i * 1_000;
      d.ingest(ev({ status: 'stopped', at: t }), t);
      d.ingest(ev({ kind: 'online', at: t + 50 }), t + 50);
      d.ingest(ev({ kind: 'restart', manuallyFlag: true, at: t + 60 }), t + 60);
      const out = d.tick(t + 4_000, autorestartOn);
      expect(out.every((c) => c.kind === 'restart')).toBe(true);
    }
    expect(d.isInCrashLoop('api', 1)).toBe(false);
  });
});

describe('what follows an exit is what classifies it', () => {
  // `manually` is ALWAYS false on an exit (God.notify('exit', proc) passes two args),
  // so nothing on the exit event itself can tell a stop from a crash.

  it('died and came back => crash', () => {
    const d = new Detector(opts);
    expect(d.ingest(ev({ exitCode: 1 }), 1000)).toEqual([]);     // held
    expect(d.ingest(ev({ kind: 'online' }), 1200)).toEqual([]);  // still held
    expect(d.tick(2000, autorestartOn)).toEqual([]);             // inside settleMs
    const out = d.tick(5000, autorestartOn);
    expect(out[0]!.kind).toBe('crash');
    expect(out[0]!.severity).toBe('warning');
  });

  it('exited cleanly and came back => restart, not an incident', () => {
    const d = new Detector(opts);
    d.ingest(ev({ exitCode: 0 }), 1000);
    d.ingest(ev({ kind: 'online' }), 1200);
    const out = d.tick(5000, autorestartOn);
    expect(out[0]!.kind).toBe('restart');
    expect(out[0]!.severity).toBe('info');
  });

  it('a REQUESTED restart is not a crash, even with a non-zero exit code', () => {
    // pm2-liveness restarting a hung instance: start/online first, then `restart` with
    // manually=true. Waiting settleMs is what lets the second event be seen.
    const d = new Detector(opts);
    d.ingest(ev({ exitCode: 1 }), 1000);
    d.ingest(ev({ kind: 'online' }), 1200);
    d.ingest(ev({ kind: 'restart', manuallyFlag: true }), 1300);
    const out = d.tick(5000, autorestartOn);
    expect(out[0]!.kind).toBe('restart');
    expect(out[0]!.detail.requested).toBe(true);
  });

  it('stayed down while autorestart was ON => a requested stop', () => {
    // PM2 would have restarted it and did not, so something asked it to stop.
    const d = new Detector(opts);
    d.ingest(ev({ exitCode: 1 }), 1000);
    expect(d.tick(20_000, autorestartOn)).toEqual([]);   // inside the restart window
    const out = d.tick(40_000, autorestartOn);
    expect(out[0]!.kind).toBe('operator-stop');
    expect(out[0]!.severity).toBe('info');
  });

  it('stayed down while autorestart was OFF => a crash, not a tidy shutdown', () => {
    // Staying down proves nothing when it was never going to come back by itself.
    const d = new Detector(opts);
    d.ingest(ev({ exitCode: 1 }), 1000);
    const out = d.tick(40_000, autorestartOff);
    expect(out[0]!.kind).toBe('crash');
    expect(out[0]!.severity).toBe('warning');
  });

  it('assumes autorestart is on when nothing is known, erring towards silence', () => {
    const d = new Detector(opts);
    d.ingest(ev({ exitCode: 1 }), 1000);
    expect(d.tick(40_000)[0]!.kind).toBe('operator-stop');
  });
});

describe('crash loops', () => {
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
    for (let i = 0; i < 20; i++) {
      loops += crashCycle(d, 10_000 + i * 1_000).filter((c) => c.kind === 'crash-loop').length;
    }
    expect(loops).toBe(1);
  });
});

describe('probe events', () => {
  const probeFail = (): NormalizedEvent => ({
    kind: 'probe-status', app: 'api', pmId: 1, at: 1000,
    probe: {
      v: 1, state: 'fail', app: 'api', pm_id: 1, probe: 'http',
      probe_kind: 'liveness', at: '2026-10-30T00:00:00.000Z',
      reason: 'status 503', action: 'restart',
    },
  });

  it('a probe failure is critical', () => {
    const out = new Detector(opts).ingest(probeFail(), 1000);
    expect(out[0]!.kind).toBe('probe-fail');
    expect(out[0]!.severity).toBe('critical');
  });

  it('the failure is reported even though the restart it causes is not', () => {
    // The pairing that matters: probe-fail alerts, and the restart it triggers is
    // classified as requested, so the incident is reported exactly once.
    const d = new Detector(opts);
    const alerts = d.ingest(probeFail(), 1000);
    d.ingest(ev({ exitCode: 1 }), 1100);
    d.ingest(ev({ kind: 'online' }), 1300);
    d.ingest(ev({ kind: 'restart', manuallyFlag: true }), 1400);
    const after = d.tick(6000, autorestartOn);
    expect(alerts[0]!.kind).toBe('probe-fail');
    expect(after.map((c) => c.kind)).toEqual(['restart']);
  });

  it('a probe recovery is reported for resolution tracking', () => {
    const e = probeFail();
    e.probe!.state = 'recovered';
    expect(new Detector(opts).ingest(e, 1000)[0]!.kind).toBe('recovered');
  });
});
