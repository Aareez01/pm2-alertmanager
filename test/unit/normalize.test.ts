import { describe, it, expect } from 'vitest';
import { normalizeProcessEvent, normalizeProbeEvent, RESTART_OVERLIMIT } from '../../src/events/normalize';

const proc = (over: Record<string, unknown> = {}) => ({
  name: 'api', pm_id: 1, status: 'stopped', exit_code: 1,
  restart_time: 2, namespace: 'default', ...over,
});

describe('normalizeProcessEvent', () => {
  it("matches 'restart overlimit' WITH THE SPACE", () => {
    // The single most likely implementation bug: PM2 emits this with a space, not a
    // colon or underscore. Getting it wrong silently disables crash-loop detection.
    const ev = normalizeProcessEvent({ event: RESTART_OVERLIMIT, process: proc() });
    expect(RESTART_OVERLIMIT).toBe('restart overlimit');
    expect(ev?.kind).toBe('restart-overlimit');
  });

  it('does not match plausible-looking variants', () => {
    for (const bad of ['restart:overlimit', 'restart_overlimit', 'restartoverlimit']) {
      expect(normalizeProcessEvent({ event: bad, process: proc() })?.kind).toBe('unknown');
    }
  });

  it('maps the rest of the native vocabulary', () => {
    const kinds = ['start', 'online', 'exit', 'restart'].map(
      (e) => normalizeProcessEvent({ event: e, process: proc() })?.kind,
    );
    expect(kinds).toEqual(['start', 'online', 'exit', 'restart']);
  });

  it('records PM2 manually flag without interpreting it', () => {
    const ev = normalizeProcessEvent({ event: 'restart', manually: true, process: proc() });
    expect(ev?.manuallyFlag).toBe(true);
  });

  it('returns null for unusable payloads', () => {
    expect(normalizeProcessEvent(null)).toBeNull();
    expect(normalizeProcessEvent({ event: 'exit', process: { name: 'api' } })).toBeNull();
  });
});

describe('normalizeProbeEvent', () => {
  const valid = {
    v: 1, state: 'fail', app: 'api', pm_id: 1, probe: 'http',
    probe_kind: 'liveness', at: '2026-10-30T00:00:00.000Z',
  };

  it('reads the payload from the bus envelope data field', () => {
    const ev = normalizeProbeEvent({ at: 1, data: valid, process: { name: 'pm2-liveness' } });
    expect(ev?.kind).toBe('probe-status');
    // Subject comes from the payload, NOT the envelope - the envelope names the emitter.
    expect(ev?.app).toBe('api');
    expect(ev?.pmId).toBe(1);
  });

  it('rejects a malformed payload', () => {
    expect(normalizeProbeEvent({ data: { v: 1, state: 'fail' } })).toBeNull();
  });
});
