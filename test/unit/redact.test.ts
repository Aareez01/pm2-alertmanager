import { describe, it, expect } from 'vitest';
import { redact, compileRules, DEFAULT_RULES } from '../../src/content/redact';

describe('redaction (REQ-AM-22)', () => {
  it('redacts an AWS access key id', () => {
    const out = redact('error: using AKIAIOSFODNN7EXAMPLE to sign');
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(out).toContain('[redacted:aws-key-id]');
  });

  it('redacts bearer tokens and JWTs', () => {
    expect(redact('Authorization: Bearer abcdef1234567890xyz'))
      .toBe('Authorization: Bearer [redacted]');
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27u';
    expect(redact(`token=${jwt}`)).not.toContain(jwt);
  });

  it('redacts credentials embedded in a connection string', () => {
    const out = redact('postgres://appuser:hunter2@db.internal:5432/main');
    expect(out).not.toContain('hunter2');
    expect(out).toContain('postgres://appuser:[redacted]@');
  });

  it('redacts assignment-style secrets', () => {
    for (const s of ['password=swordfish', 'api_key: "abc123"', 'SECRET=zzz']) {
      expect(redact(s)).not.toMatch(/swordfish|abc123|zzz/);
    }
  });

  it('redacts a private key block', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----';
    expect(redact(`key: ${pem}`)).toBe('key: [redacted:private-key]');
  });

  it('redacts a slack webhook url so our own config cannot leak', () => {
    expect(redact('posting to https://hooks.slack.com/services/T00/B00/XXXX'))
      .toContain('[redacted:slack-webhook]');
  });

  it('leaves ordinary log lines untouched', () => {
    const line = 'TypeError: Cannot read properties of undefined (reading \'id\')';
    expect(redact(line)).toBe(line);
  });

  it('is applied repeatedly without the global flag leaking state', () => {
    const s = 'AKIAIOSFODNN7EXAMPLE';
    expect(redact(s)).toBe(redact(s));
  });

  it('ignores an invalid custom regex rather than disabling the built-ins', () => {
    const rules = compileRules([{ name: 'bad', pattern: '([unclosed' }]);
    expect(rules.length).toBe(DEFAULT_RULES.length);
    expect(redact('AKIAIOSFODNN7EXAMPLE', rules)).toContain('[redacted:aws-key-id]');
  });
});
