import { describe, it, expect } from 'vitest';
import { route, matches, Route } from '../../src/core/router';
import { alertFrom } from '../../src/core/alert';

const a = (over: Record<string, unknown> = {}) =>
  ({ ...alertFrom({ kind: 'crash', severity: 'warning', app: 'api-users',
     pmId: 1, at: 0, detail: {} }, 'h'), ...over } as ReturnType<typeof alertFrom>);

describe('routing (REQ-AM-16)', () => {
  it('matches an app glob', () => {
    expect(matches({ match: { app: 'api-*' }, channels: ['x'] }, a())).toBe(true);
    expect(matches({ match: { app: 'web-*' }, channels: ['x'] }, a())).toBe(false);
  });

  it('treats severity as a floor, not an equality test', () => {
    const r: Route = { match: { severity: 'warning' }, channels: ['x'] };
    expect(matches(r, a({ severity: 'critical' }))).toBe(true);
    expect(matches(r, a({ severity: 'info' }))).toBe(false);
  });

  it('filters on condition', () => {
    const r: Route = { match: { condition: ['crash-loop'] }, channels: ['x'] };
    expect(matches(r, a())).toBe(false);
    expect(matches(r, a({ kind: 'crash-loop' }))).toBe(true);
  });

  it('is first-match-wins with an empty match acting as the default', () => {
    const routes: Route[] = [
      { match: { app: 'api-*', severity: 'critical' }, channels: ['pager'] },
      { match: {}, channels: ['slack'] },
    ];
    expect(route(routes, a({ severity: 'critical' }))).toEqual(['pager']);
    expect(route(routes, a({ severity: 'warning' }))).toEqual(['slack']);
  });

  it('returns no channels when nothing matches', () => {
    expect(route([{ match: { app: 'nope' }, channels: ['x'] }], a())).toEqual([]);
  });

  it('does not let a glob escape into regex metacharacters', () => {
    expect(matches({ match: { app: 'api.users' }, channels: ['x'] },
      a({ app: 'apiXusers' }))).toBe(false);
  });
});
