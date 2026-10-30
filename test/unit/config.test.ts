import { describe, it, expect } from 'vitest';
import { parseConfig, ConfigError, interpolateEnv, redactConfigForDisplay } from '../../src/config/schema';

const base = {
  channels: { slack: { type: 'slack', webhookUrl: 'https://hooks.slack.com/services/x' } },
  routes: [{ match: {}, channels: ['slack'] }],
};

describe('config validation', () => {
  it('applies defaults', () => {
    const c = parseConfig(base);
    expect(c.startupGraceSeconds).toBe(60);
    expect(c.suppression.dedupWindowSeconds).toBe(300);
    expect(c.suppression.minSeverity).toBe('warning');
    expect(c.content.logLines).toBe(15);
    expect(c.delivery.attempts).toBe(3);
  });

  it('rejects a route pointing at a channel that does not exist', () => {
    // Silent failure at 3am otherwise.
    try {
      parseConfig({ ...base, routes: [{ match: {}, channels: ['typo'] }] });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).issues.join()).toMatch(/no channel named "typo"/);
    }
  });

  it('names the offending path on a type error', () => {
    try {
      parseConfig({ ...base, content: { logLines: 'fifteen' } });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ConfigError).issues.join()).toMatch(/content\.logLines/);
    }
  });

  it('rejects an unknown channel type', () => {
    expect(() => parseConfig({ channels: { x: { type: 'carrier-pigeon' } }, routes: [] }))
      .toThrow(ConfigError);
  });
});

describe('secret handling (REQ-AM-29)', () => {
  it('interpolates ${ENV_VAR} so webhook urls need not sit in module_conf.json', () => {
    const out = interpolateEnv({ url: 'https://x/${TOKEN}/y' }, { TOKEN: 'abc' } as NodeJS.ProcessEnv);
    expect(out).toEqual({ url: 'https://x/abc/y' });
  });

  it('interpolates through a full config parse', () => {
    const c = parseConfig(
      { channels: { s: { type: 'slack', webhookUrl: '${HOOK}' } },
        routes: [{ match: {}, channels: ['s'] }] },
      { HOOK: 'https://hooks.slack.com/services/real' } as NodeJS.ProcessEnv,
    );
    expect(c.channels.s).toMatchObject({ webhookUrl: 'https://hooks.slack.com/services/real' });
  });

  it('masks secrets for display', () => {
    const shown = redactConfigForDisplay(parseConfig(base)) as
      { channels: Record<string, { webhookUrl: string }> };
    expect(shown.channels.slack!.webhookUrl).toBe('[redacted]');
  });
});
