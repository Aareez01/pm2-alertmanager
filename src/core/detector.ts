import { NormalizedEvent } from '../events/normalize';

/**
 * Derives meaningful conditions from PM2's raw event stream.
 *
 * PM2 gives us five event names and nothing else: start, online, exit, restart and
 * 'restart overlimit'. There is no "crashed" event, no "an operator stopped this" event,
 * and no way to tell a deliberate stop from a fatal error by event name alone. All of that
 * has to be inferred here, and three properties of the stream make naive inference wrong:
 *
 *  1. `exit` fires TWICE per restart - once with status=stopping, once with status=stopped.
 *     Counting raw exits trips crash-loop detection at half the configured threshold.
 *
 *  2. `manually` is ALWAYS FALSE on an exit event. God.notify('exit', proc) passes two
 *     arguments, and Event.js sets manually = (typeof arg === 'undefined' ? false : true).
 *     The flag is only ever true on `start` and on the `restart` event raised through
 *     notifyByProcessId. So it cannot classify an exit at all - and where it IS true, it
 *     means "PM2 was asked to do this", not "a human did it", since a pm2.restart() from
 *     pm2-probe sets it too.
 *
 *     What distinguishes a deliberate stop from a crash is therefore NOT on the exit
 *     event. It is what happens next: a requested restart is followed by a `restart`
 *     event; a crash with autorestart is followed only by start/online; a deliberate stop
 *     is followed by nothing at all while autorestart is still enabled.
 *
 *  3. An `exit` with a clean exit code is genuinely ambiguous at the moment it arrives: a
 *     restart and an operator stop look identical. The difference is only visible slightly
 *     later - a restart is followed by start/online, a stop leaves the process down. So
 *     that one case is deferred and resolved by tick().
 *
 * This class is pure: every method takes `now`, so the whole state machine is testable
 * without timers.
 */

export type ConditionKind =
  | 'crash'
  | 'crash-loop'
  | 'operator-stop'
  | 'restart'
  | 'probe-fail'
  | 'recovered'
  | 'memory-restart';

export type Severity = 'info' | 'warning' | 'critical';

export interface Condition {
  kind: ConditionKind;
  severity: Severity;
  app: string;
  pmId: number;
  namespace?: string;
  at: number;
  detail: Record<string, unknown>;
}

export interface DetectorOptions {
  /** How long to wait, once an instance is back, for a `restart` event to arrive. */
  settleMs: number;
  /** How long to wait before concluding an instance is not coming back at all. */
  restartWindowMs: number;
  crashLoopThreshold: number;
  crashLoopWindowMs: number;
}

export const DEFAULT_DETECTOR_OPTIONS: DetectorOptions = {
  settleMs: 3_000,
  restartWindowMs: 30_000,
  crashLoopThreshold: 3,
  crashLoopWindowMs: 60_000,
};

interface Pending {
  at: number;
  ev: NormalizedEvent;
  /** A start/online arrived for this instance. */
  cameBack: boolean;
  /** A `restart` event with manually=true arrived - PM2 was asked to do this. */
  requestedRestart: boolean;
}

interface InstanceState {
  exits: number[];
  pending: Pending | null;
  inCrashLoop: boolean;
}

/** Settled facts the detector cannot learn from the bus. */
export interface SettledState {
  autorestart: boolean;
}

export type SettledLookup = (app: string, pmId: number) => SettledState | null;

export class Detector {
  private readonly state = new Map<string, InstanceState>();

  constructor(private readonly opts: DetectorOptions = DEFAULT_DETECTOR_OPTIONS) {}

  private key(app: string, pmId: number): string {
    return `${app}:${pmId}`;
  }

  private get(app: string, pmId: number): InstanceState {
    const k = this.key(app, pmId);
    let s = this.state.get(k);
    if (!s) {
      s = { exits: [], pending: null, inCrashLoop: false };
      this.state.set(k, s);
    }
    return s;
  }

  private base(ev: NormalizedEvent) {
    return { app: ev.app, pmId: ev.pmId, namespace: ev.namespace, at: ev.at };
  }

  ingest(ev: NormalizedEvent, now: number = Date.now()): Condition[] {
    switch (ev.kind) {
      case 'exit':
        return this.onExit(ev, now);
      case 'start':
      case 'online':
      case 'restart':
        return this.onUp(ev);
      case 'restart-overlimit':
        return this.onOverlimit(ev);
      case 'probe-status':
        return this.onProbe(ev);
      default:
        return [];
    }
  }

  private onExit(ev: NormalizedEvent, now: number): Condition[] {
    // Half of every restart. Ignoring 'stopping' is what keeps counts honest.
    if (ev.status !== 'stopped') return [];

    const s = this.get(ev.app, ev.pmId);
    const out: Condition[] = [];

    // Exits are NOT counted here. A crash loop is a loop of CRASHES, and whether this
    // exit was one is not known yet - `pm2 set` restarts a module, so a handful of
    // config changes would otherwise look exactly like an app dying repeatedly.
    s.pending = { at: now, ev, cameBack: false, requestedRestart: false };
    return out;
  }

  /**
   * Count a confirmed crash, escalating once they cluster.
   *
   * Returns null while a loop is already being reported: one alert describes the
   * situation and further ones add nothing.
   */
  private recordCrash(
    s: InstanceState,
    ev: NormalizedEvent,
    now: number,
    detail: Record<string, unknown>,
  ): Condition | null {
    s.exits.push(now);
    const cutoff = now - this.opts.crashLoopWindowMs;
    while (s.exits.length > 0 && (s.exits[0] as number) < cutoff) s.exits.shift();

    if (s.inCrashLoop) return null;

    if (s.exits.length >= this.opts.crashLoopThreshold) {
      s.inCrashLoop = true;
      return {
        ...this.base(ev),
        kind: 'crash-loop',
        severity: 'critical',
        detail: {
          crashes: s.exits.length,
          windowSeconds: Math.round(this.opts.crashLoopWindowMs / 1000),
          firstAt: s.exits[0],
          lastAt: now,
          unstableRestarts: ev.unstableRestarts,
          errLogPath: ev.errLogPath,
        },
      };
    }
    return { ...this.base(ev), kind: 'crash', severity: 'warning', detail };
  }

  /** A loop is over once no crash has landed inside the window. */
  private sweepCrashLoops(now: number): void {
    const cutoff = now - this.opts.crashLoopWindowMs;
    for (const s of this.state.values()) {
      if (!s.inCrashLoop) continue;
      while (s.exits.length > 0 && (s.exits[0] as number) < cutoff) s.exits.shift();
      if (s.exits.length < this.opts.crashLoopThreshold) s.inCrashLoop = false;
    }
  }

  private onUp(ev: NormalizedEvent): Condition[] {
    const s = this.get(ev.app, ev.pmId);
    // Deliberately does NOT clear inCrashLoop: coming back up is what a crash loop IS.
    // The loop clears when crashes stop arriving (see sweep in tick) or on recovery.
    if (!s.pending) return [];

    s.pending.cameBack = true;
    // `restart` with manually=true is the one place PM2 tells us it was ASKED to act.
    // It arrives just after start/online, which is why classification waits settleMs.
    if (ev.kind === 'restart' && ev.manuallyFlag === true) {
      s.pending.requestedRestart = true;
    }
    return [];
  }

  private onOverlimit(ev: NormalizedEvent): Condition[] {
    const s = this.get(ev.app, ev.pmId);
    s.inCrashLoop = true;
    s.pending = null;
    return [{
      ...this.base(ev),
      kind: 'crash-loop',
      severity: 'critical',
      detail: {
        trigger: 'restart overlimit',
        unstableRestarts: ev.unstableRestarts,
        restartTime: ev.restartTime,
        errLogPath: ev.errLogPath,
      },
    }];
  }

  private onProbe(ev: NormalizedEvent): Condition[] {
    const p = ev.probe;
    if (!p) return [];
    if (p.state === 'fail') {
      return [{
        ...this.base(ev),
        kind: 'probe-fail',
        severity: 'critical',
        detail: {
          probe: p.probe,
          probeKind: p.probe_kind,
          reason: p.reason,
          consecutive: p.consecutive,
          threshold: p.threshold,
          action: p.action,
        },
      }];
    }
    if (p.state === 'recovered') {
      const s = this.get(ev.app, ev.pmId);
      s.inCrashLoop = false;
      s.exits = [];
      return [{ ...this.base(ev), kind: 'recovered', severity: 'info',
        detail: { probe: p.probe, probeKind: p.probe_kind } }];
    }
    return [];
  }

  /**
   * Classify held exits once enough has happened to tell them apart.
   *
   * `lookup` supplies autorestart, which the bus never carries: if PM2 would have
   * restarted an instance and simply did not, it was asked to stop. Without it, an app
   * that died with autorestart off and stayed down would be filed as a tidy shutdown.
   */
  tick(now: number = Date.now(), lookup?: SettledLookup): Condition[] {
    const out: Condition[] = [];
    this.sweepCrashLoops(now);
    for (const s of this.state.values()) {
      const p = s.pending;
      if (!p) continue;

      if (p.cameBack) {
        if (now - p.at < this.opts.settleMs) continue;
        s.pending = null;

        if (p.requestedRestart) {
          // Something asked PM2 to restart this - a deploy, an operator, or pm2-probe.
          // The reason it was unhealthy, if it was, is reported by probe-fail.
          out.push({ ...this.base(p.ev), kind: 'restart', severity: 'info',
            detail: { restartTime: p.ev.restartTime, requested: true } });
          continue;
        }
        if (typeof p.ev.exitCode === 'number' && p.ev.exitCode !== 0) {
          // Died by itself and PM2 brought it back: a crash, however briefly.
          const c = this.recordCrash(s, p.ev, now, {
            exitCode: p.ev.exitCode, restartTime: p.ev.restartTime,
            unstableRestarts: p.ev.unstableRestarts, errLogPath: p.ev.errLogPath,
            revision: p.ev.revision });
          if (c) out.push(c);
          continue;
        }
        out.push({ ...this.base(p.ev), kind: 'restart', severity: 'info',
          detail: { restartTime: p.ev.restartTime } });
        continue;
      }

      if (now - p.at < this.opts.restartWindowMs) continue;
      s.pending = null;

      const settled = lookup ? lookup(p.ev.app, p.ev.pmId) : null;
      if (settled && settled.autorestart === false) {
        // It would never have come back on its own, so staying down proves nothing.
        const c = this.recordCrash(s, p.ev, now, {
          exitCode: p.ev.exitCode, errLogPath: p.ev.errLogPath,
          note: 'exited and stayed down with autorestart disabled' });
        if (c) out.push(c);
        continue;
      }

      // PM2 would have restarted it and did not: it was asked to stop.
      out.push({ ...this.base(p.ev), kind: 'operator-stop', severity: 'info', detail: {
        exitCode: p.ev.exitCode,
        note: 'stayed down although autorestart is enabled, so the stop was requested' } });
    }
    return out;
  }

  /** Test/diagnostic helper. */
  isInCrashLoop(app: string, pmId: number): boolean {
    return this.get(app, pmId).inCrashLoop;
  }
}
