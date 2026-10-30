import { Alert, atLeast } from './alert';
import { Severity } from './detector';

/**
 * Noise control. This is the actual product.
 *
 * Sending a Slack message when a process dies is a twenty-line script; several already
 * exist. What makes an alerting tool usable on-call is everything in this file: an app
 * crash-looping fifty times must produce one notification, a PM2 daemon restart must
 * produce none at all, and every decision to stay silent must be explainable afterwards.
 *
 * Every method takes `now` so the whole thing is testable without timers.
 */

export type SuppressReason =
  | 'startup-grace'
  | 'deduplicated'
  | 'crash-loop-active'
  | 'flapping'
  | 'quiet-hours'
  | 'below-severity-threshold';

export interface Decision {
  send: boolean;
  reason?: SuppressReason;
  /** Set when the decision is to hold the alert for a later summary, not drop it. */
  hold?: boolean;
}

export interface QuietHours {
  enabled: boolean;
  /** 0-23 local to `timezone`. start 22, end 7 means 22:00 -> 07:00. */
  startHour: number;
  endHour: number;
  timezone: string;
  /** Severities at or above this are always sent, even during quiet hours. */
  alwaysSend: Severity;
}

export interface SuppressorOptions {
  startupGraceMs: number;
  dedupWindowMs: number;
  crashLoopRenotifyMs: number;
  flapThreshold: number;
  flapWindowMs: number;
  minSeverity: Severity;
  quietHours: QuietHours;
}

export const DEFAULT_SUPPRESSOR_OPTIONS: SuppressorOptions = {
  startupGraceMs: 60_000,
  dedupWindowMs: 300_000,
  crashLoopRenotifyMs: 3_600_000,
  flapThreshold: 4,
  flapWindowMs: 600_000,
  minSeverity: 'warning',
  quietHours: {
    enabled: false,
    startHour: 22,
    endHour: 7,
    timezone: 'UTC',
    alwaysSend: 'critical',
  },
};

function hourIn(tz: string, at: number): number {
  try {
    const s = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hour: '2-digit', hour12: false,
    }).format(new Date(at));
    const h = parseInt(s, 10);
    return Number.isFinite(h) ? h % 24 : new Date(at).getUTCHours();
  } catch {
    // An invalid timezone must not break alerting.
    return new Date(at).getUTCHours();
  }
}

export function inQuietHours(q: QuietHours, at: number): boolean {
  if (!q.enabled) return false;
  const h = hourIn(q.timezone, at);
  // A window that wraps midnight (22 -> 7) is the common case.
  return q.startHour <= q.endHour
    ? h >= q.startHour && h < q.endHour
    : h >= q.startHour || h < q.endHour;
}

export class Suppressor {
  private lastSent = new Map<string, number>();
  private crashLoopUntil = new Map<string, number>();
  private transitions = new Map<string, number[]>();
  private flappingUntil = new Map<string, number>();

  constructor(
    private readonly opts: SuppressorOptions,
    private readonly bootAt: number,
  ) {}

  /**
   * A PM2 daemon restart emits start+online for every app at once. Without this, every
   * module restart pages the whole team - and the module restarts itself whenever
   * `pm2 set` changes its config.
   */
  private inStartupGrace(now: number): boolean {
    return now - this.bootAt < this.opts.startupGraceMs;
  }

  evaluate(alert: Alert, now: number): Decision {
    if (!atLeast(alert.severity, this.opts.minSeverity)) {
      return { send: false, reason: 'below-severity-threshold' };
    }

    if (this.inStartupGrace(now)) {
      return { send: false, reason: 'startup-grace', hold: true };
    }

    // While an app is known to be crash-looping, one alert already describes the
    // situation; further ones add nothing but noise.
    const loopUntil = this.crashLoopUntil.get(alert.app);
    if (loopUntil !== undefined && now < loopUntil && alert.kind !== 'recovered') {
      if (alert.kind !== 'crash-loop') {
        return { send: false, reason: 'crash-loop-active' };
      }
      return { send: false, reason: 'deduplicated' };
    }

    const flapUntil = this.flappingUntil.get(alert.app);
    if (flapUntil !== undefined && now < flapUntil && alert.kind !== 'recovered') {
      return { send: false, reason: 'flapping' };
    }

    const last = this.lastSent.get(alert.fingerprint);
    if (last !== undefined && now - last < this.opts.dedupWindowMs) {
      return { send: false, reason: 'deduplicated' };
    }

    if (
      inQuietHours(this.opts.quietHours, now) &&
      !atLeast(alert.severity, this.opts.quietHours.alwaysSend)
    ) {
      // Held for the end-of-window summary rather than dropped.
      return { send: false, reason: 'quiet-hours', hold: true };
    }

    return { send: true };
  }

  /** Record that an alert actually went out. */
  noteSent(alert: Alert, now: number): void {
    this.lastSent.set(alert.fingerprint, now);
    if (alert.kind === 'crash-loop') {
      this.crashLoopUntil.set(alert.app, now + this.opts.crashLoopRenotifyMs);
    }
  }

  /** Track healthy<->unhealthy churn so a flapping app is alerted once, not per flip. */
  noteTransition(app: string, now: number): boolean {
    const list = this.transitions.get(app) ?? [];
    list.push(now);
    const cutoff = now - this.opts.flapWindowMs;
    while (list.length > 0 && (list[0] as number) < cutoff) list.shift();
    this.transitions.set(app, list);

    if (list.length >= this.opts.flapThreshold) {
      const already = this.flappingUntil.get(app);
      if (already === undefined || now >= already) {
        this.flappingUntil.set(app, now + this.opts.flapWindowMs);
        return true; // caller should emit a single "flapping" alert
      }
    }
    return false;
  }

  /** An app returning to health clears its loop and flap suppression. */
  noteRecovered(app: string): void {
    this.crashLoopUntil.delete(app);
    this.flappingUntil.delete(app);
    this.transitions.delete(app);
  }

  /** For persistence across module restarts. */
  snapshot(): Record<string, unknown> {
    return {
      lastSent: [...this.lastSent],
      crashLoopUntil: [...this.crashLoopUntil],
      flappingUntil: [...this.flappingUntil],
    };
  }

  restore(s: Record<string, unknown> | null | undefined): void {
    if (!s) return;
    const asMap = (v: unknown): Map<string, number> =>
      Array.isArray(v) ? new Map(v as [string, number][]) : new Map();
    this.lastSent = asMap(s.lastSent);
    this.crashLoopUntil = asMap(s.crashLoopUntil);
    this.flappingUntil = asMap(s.flappingUntil);
  }
}
