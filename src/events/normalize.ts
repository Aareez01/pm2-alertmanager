import { ProbeStatusEvent, isProbeStatusEvent } from './contract';

/**
 * Turns raw PM2 bus payloads into a normalized shape.
 *
 * The native vocabulary, verified against PM2 7.1.1 by observing a live bus:
 *   start, online, exit, restart, restart overlimit
 *
 * Note 'restart overlimit' has a SPACE in it - not a colon or an underscore. Getting this
 * wrong silently disables crash-loop detection, which is why it has a dedicated test.
 */

export const RESTART_OVERLIMIT = 'restart overlimit';

export type EventKind =
  | 'start'
  | 'online'
  | 'exit'
  | 'restart'
  | 'restart-overlimit'
  | 'probe-status'
  | 'unknown';

export interface NormalizedEvent {
  kind: EventKind;
  app: string;
  pmId: number;
  namespace?: string;
  /**
   * The status PM2 reported AT EMIT TIME - the `online` event carries status=launching.
   * Never treat this as settled state; read settled state from pm2.list().
   */
  status?: string;
  exitCode?: number | null;
  restartTime?: number;
  unstableRestarts?: number;
  errLogPath?: string;
  revision?: string | null;
  /** PM2's `manually` flag. Recorded for diagnostics ONLY - see the warning below. */
  manuallyFlag?: boolean;
  probe?: ProbeStatusEvent;
  at: number;
}

interface BusProcessEvent {
  event?: string;
  manually?: boolean;
  at?: number | string;
  process?: Record<string, unknown>;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export function normalizeProcessEvent(payload: unknown): NormalizedEvent | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as BusProcessEvent;
  const proc = p.process ?? {};

  const app = str(proc.name);
  const pmId = num(proc.pm_id);
  if (!app || pmId === undefined) return null;

  let kind: EventKind;
  switch (p.event) {
    case 'start': kind = 'start'; break;
    case 'online': kind = 'online'; break;
    case 'exit': kind = 'exit'; break;
    case 'restart': kind = 'restart'; break;
    case RESTART_OVERLIMIT: kind = 'restart-overlimit'; break;
    default: kind = 'unknown';
  }

  const versioning = proc.versioning as { revision?: string } | null | undefined;

  return {
    kind,
    app,
    pmId,
    namespace: str(proc.namespace),
    status: str(proc.status),
    exitCode: typeof proc.exit_code === 'number' ? proc.exit_code : null,
    restartTime: num(proc.restart_time),
    unstableRestarts: num(proc.unstable_restarts),
    errLogPath: str(proc.pm_err_log_path),
    revision: versioning?.revision ?? null,
    manuallyFlag: typeof p.manually === 'boolean' ? p.manually : undefined,
    at: typeof p.at === 'number' ? p.at : Date.now(),
  };
}

/** The bus envelope for a custom typed message puts the payload under `data`. */
export function normalizeProbeEvent(payload: unknown): NormalizedEvent | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const data = (payload as { data?: unknown }).data;
  if (!isProbeStatusEvent(data)) return null;
  return {
    kind: 'probe-status',
    app: data.app,
    pmId: data.pm_id,
    namespace: data.namespace,
    revision: data.rev ?? null,
    probe: data,
    at: Date.parse(data.at) || Date.now(),
  };
}
