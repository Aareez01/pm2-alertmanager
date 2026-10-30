/**
 * Redaction for anything leaving the host.
 *
 * Alerts carry stderr excerpts to an external chat service. A stack trace routinely
 * contains a connection string, an Authorization header or an API key, and once it is in
 * a channel it is in that channel's history, its search index and its exports. Redaction
 * is on by default and not optional.
 */

export interface RedactionRule {
  name: string;
  pattern: RegExp;
  /** Replacement; $1 etc. refer to capture groups in `pattern`. */
  replacement: string;
}

export const DEFAULT_RULES: RedactionRule[] = [
  { name: 'aws-access-key-id', pattern: /\b((?:AKIA|ASIA|AIDA|AROA)[A-Z0-9]{16})\b/g,
    replacement: '[redacted:aws-key-id]' },
  { name: 'aws-secret', pattern: /\b(aws_secret_access_key\s*[=:]\s*)\S+/gi,
    replacement: '$1[redacted]' },
  { name: 'bearer-token', pattern: /\b(Bearer\s+)[A-Za-z0-9._~+/-]{12,}=*/g,
    replacement: '$1[redacted]' },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replacement: '[redacted:jwt]' },
  { name: 'url-credentials', pattern: /\b([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s:@/]+):[^\s@/]+@/g,
    replacement: '$1:[redacted]@' },
  { name: 'generic-secret-assignment',
    pattern: /\b((?:password|passwd|secret|token|api[_-]?key|apikey|access[_-]?key)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi,
    replacement: '$1[redacted]' },
  { name: 'private-key-block',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: '[redacted:private-key]' },
  { name: 'slack-webhook', pattern: /https:\/\/hooks\.slack\.com\/services\/\S+/g,
    replacement: '[redacted:slack-webhook]' },
];

export function compileRules(extra: { name: string; pattern: string; replacement?: string }[] = []):
  RedactionRule[] {
  const custom: RedactionRule[] = [];
  for (const r of extra) {
    try {
      custom.push({
        name: r.name,
        pattern: new RegExp(r.pattern, 'g'),
        replacement: r.replacement ?? '[redacted]',
      });
    } catch {
      // A bad user regex must not disable the built-in rules.
    }
  }
  return [...DEFAULT_RULES, ...custom];
}

export function redact(text: string, rules: RedactionRule[] = DEFAULT_RULES): string {
  let out = text;
  for (const r of rules) {
    r.pattern.lastIndex = 0;
    out = out.replace(r.pattern, r.replacement);
  }
  return out;
}
