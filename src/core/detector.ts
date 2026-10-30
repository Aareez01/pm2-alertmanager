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
 *  2. `manually: true` does NOT mean a human did it. It means "via the API or CLI", so a
 *     pm2.restart() call from pm2-probe sets it. Suppressing on this flag would silently
 *     swallow exactly the failures worth paging about. We record the flag for diagnostics
 *     and never branch on it.
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
  | 'recovered';

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
  /** How long to wait before deciding a clean exit was a stop, not a restart. */
  restartWindowMs: number;
  crashLoopThreshold: number;
  crashLoopWindowMs: number;
}

export const DEFAULT_DETECTOR_OPTIONS: DetectorOptions = {
  restartWindowMs: 30_000,
  crashLoopThreshold: 3,
  crashLoopWindowMs: 60_000,
};

interface InstanceState {
  exits: number[];
  pending: { at: number; ev: NormalizedEvent } | null;
  inCrashLoop: boolean;
}

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

    s.exits.push(now);
    const cutoff = now - this.opts.crashLoopWindowMs;
    while (s.exits.length > 0 && (s.exits[0] as number) < cutoff) s.exits.shift();

    if (s.exits.length >= this.opts.crashLoopThreshold && !s.inCrashLoop) {
      s.inCrashLoop = true;
      out.push({
        ...this.base(ev),
        kind: 'crash-loop',
        severity: 'critical',
        detail: {
          exits: s.exits.length,
          windowSeconds: Math.round(this.opts.crashLoopWindowMs / 1000),
          firstAt: s.exits[0],
          lastAt: now,
          unstableRestarts: ev.unstableRestarts,
          errLogPath: ev.errLogPath,
        },
      });
      s.pending = null;
      return out;
    }

    const crashed = typeof ev.exitCode === 'number' && ev.exitCode !== 0;
    if (crashed) {
      out.push({
        ...this.base(ev),
        kind: 'crash',
        severity: 'warning',
        detail: {
          exitCode: ev.exitCode,
          restartTime: ev.restartTime,
          unstableRestarts: ev.unstableRestarts,
          errLogPath: ev.errLogPath,
          revision: ev.revision,
          // Recorded, never branched on - see the note at the top of this file.
          pm2ManuallyFlag: ev.manuallyFlag,
        },
      });
      return out;
    }

    // Clean exit: could be a restart or a stop. Decide once we see what follows.
    s.pending = { at: now, ev };
    return out;
  }

  private onUp(ev: NormalizedEvent): Condition[] {
    const s = this.get(ev.app, ev.pmId);
    s.inCrashLoop = false;
    if (!s.pending) return [];
    s.pending = null;
    // It came back, so the clean exit was a restart rather than a stop.
    return [{ ...this.base(ev), kind: 'restart', severity: 'info', detail: {
      restartTime: ev.restartTime, pm2ManuallyFlag: ev.manuallyFlag } }];
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
      return [{ ...this.base(ev), kind: 'recovered', severity: 'info',
        detail: { probe: p.probe, probeKind: p.probe_kind } }];
    }
    return [];
  }

  /** Resolve clean exits that were never followed by the process coming back up. */
  tick(now: number = Date.now()): Condition[] {
    const out: Condition[] = [];
    for (const s of this.state.values()) {
      if (!s.pending) continue;
      if (now - s.pending.at < this.opts.restartWindowMs) continue;
      const ev = s.pending.ev;
      s.pending = null;
      out.push({
        ...this.base(ev),
        kind: 'operator-stop',
        severity: 'info',
        detail: {
          exitCode: ev.exitCode,
          note: 'process stayed down past the restart window',
          pm2ManuallyFlag: ev.manuallyFlag,
        },
      });
    }
    return out;
  }

  /** Test/diagnostic helper. */
  isInCrashLoop(app: string, pmId: number): boolean {
    return this.get(app, pmId).inCrashLoop;
  }
}
