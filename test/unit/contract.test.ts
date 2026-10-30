import { describe, it, expect } from 'vitest';
import {
  isProbeStatusEvent, isSupportedVersion, SUPPORTED_CONTRACT_VERSION, ProbeStatusEvent,
} from '../../src/events/contract';

const valid: ProbeStatusEvent = {
  v: SUPPORTED_CONTRACT_VERSION, state: 'fail', app: 'api', pm_id: 1,
  probe: 'http', probe_kind: 'liveness', at: '2026-10-30T00:00:00.000Z',
};

describe('consumer side of the wire contract', () => {
  it('accepts required fields only', () => {
    expect(isProbeStatusEvent(valid)).toBe(true);
  });

  it('tolerates fields added by a newer producer (C3)', () => {
    expect(isProbeStatusEvent({ ...valid, futureField: 'x' })).toBe(true);
  });

  it('rejects a payload missing a required field', () => {
    const { pm_id, ...without } = valid;
    expect(isProbeStatusEvent(without)).toBe(false);
  });

  it('flags an unsupported contract version rather than guessing (C1)', () => {
    expect(isSupportedVersion(valid)).toBe(true);
    expect(isSupportedVersion({ ...valid, v: 2 })).toBe(false);
  });
});
