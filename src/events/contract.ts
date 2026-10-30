/**
 * Consumer-side copy of the pm2-probe:status wire contract.
 *
 * This is deliberately a COPY, not an import. The contract is a wire format - like any
 * webhook payload - and pm2-probe ships from a separate repository on its own release
 * cadence. Taking a package dependency on the producer would couple two modules that are
 * meant to be independently installable; neither may hard-depend on the other.
 *
 * Normative definition: pm2-ops-contract/00-platform-and-contract.md
 */

export const PROBE_STATUS_EVENT = 'pm2-probe:status';

/** The contract version this consumer understands. */
export const SUPPORTED_CONTRACT_VERSION = 1;

export type ProbeState = 'pass' | 'fail' | 'recovered';
export type ProbeKind = 'liveness' | 'readiness';
export type ProbeType = 'http' | 'tcp' | 'exec' | 'loop-lag';

export interface ProbeStatusEvent {
  v: number;
  state: ProbeState;
  app: string;
  pm_id: number;
  probe: ProbeType;
  probe_kind: ProbeKind;
  at: string;
  namespace?: string;
  reason?: string;
  consecutive?: number;
  threshold?: number;
  latency_ms?: number;
  action?: 'restart' | 'none';
  rev?: string | null;
  host?: string;
}

const STATES: readonly string[] = ['pass', 'fail', 'recovered'];
const KINDS: readonly string[] = ['liveness', 'readiness'];
const TYPES: readonly string[] = ['http', 'tcp', 'exec', 'loop-lag'];

/** Checks the required fields only (C4) and tolerates unknown extras (C3). */
export function isProbeStatusEvent(x: unknown): x is ProbeStatusEvent {
  if (typeof x !== 'object' || x === null) return false;
  const e = x as Record<string, unknown>;
  return (
    typeof e.v === 'number' &&
    typeof e.app === 'string' &&
    typeof e.pm_id === 'number' &&
    typeof e.at === 'string' &&
    typeof e.state === 'string' && STATES.includes(e.state) &&
    typeof e.probe === 'string' && TYPES.includes(e.probe) &&
    typeof e.probe_kind === 'string' && KINDS.includes(e.probe_kind)
  );
}

export function isSupportedVersion(e: ProbeStatusEvent): boolean {
  return e.v === SUPPORTED_CONTRACT_VERSION;
}
