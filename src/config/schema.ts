import { z } from 'zod';

const severity = z.enum(['info', 'warning', 'critical']);
const condition = z.enum([
  'crash', 'crash-loop', 'operator-stop', 'restart', 'probe-fail', 'recovered',
]);

const slackChannel = z.object({
  type: z.literal('slack'),
  webhookUrl: z.string().min(1),
  timeoutMs: z.number().int().positive().default(10_000),
});

const webhookChannel = z.object({
  type: z.literal('webhook'),
  url: z.string().min(1),
  headers: z.record(z.string()).default({}),
  /** Optional JSON template with {{app}}, {{title}}, {{severity}} etc. */
  template: z.string().nullable().default(null),
  timeoutMs: z.number().int().positive().default(10_000),
});

const channel = z.discriminatedUnion('type', [slackChannel, webhookChannel]);

const route = z.object({
  match: z.object({
    app: z.string().optional(),
    namespace: z.string().optional(),
    severity: severity.optional(),
    condition: z.array(condition).optional(),
  }).default({}),
  channels: z.array(z.string().min(1)).min(1),
});

const quietHours = z.object({
  enabled: z.boolean().default(false),
  startHour: z.number().int().min(0).max(23).default(22),
  endHour: z.number().int().min(0).max(23).default(7),
  timezone: z.string().default('UTC'),
  alwaysSend: severity.default('critical'),
}).default({});

export const configSchema = z.object({
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  startupGraceSeconds: z.number().nonnegative().default(60),
  reconcileSeconds: z.number().positive().default(30),
  resolveAfterSeconds: z.number().positive().default(120),
  stateFile: z.string().default(''),

  detector: z.object({
    restartWindowSeconds: z.number().positive().default(30),
    crashLoopThreshold: z.number().int().positive().default(3),
    crashLoopWindowSeconds: z.number().positive().default(60),
  }).default({}),

  suppression: z.object({
    /** Events inside this window collapse into one notification. */
    groupWindowSeconds: z.number().positive().default(30),
    dedupWindowSeconds: z.number().positive().default(300),
    crashLoopRenotifySeconds: z.number().positive().default(3600),
    flapThreshold: z.number().int().positive().default(4),
    flapWindowSeconds: z.number().positive().default(600),
    minSeverity: severity.default('warning'),
    quietHours,
  }).default({}),

  delivery: z.object({
    attempts: z.number().int().positive().max(10).default(3),
    baseBackoffMs: z.number().int().positive().default(1000),
    ratePerMinute: z.number().int().positive().default(20),
  }).default({}),

  content: z.object({
    logLines: z.number().int().min(0).max(100).default(15),
    maxBytes: z.number().int().positive().default(40_000),
    redactions: z.array(z.object({
      name: z.string(),
      pattern: z.string(),
      replacement: z.string().default('[redacted]'),
    })).default([]),
  }).default({}),

  channels: z.record(channel).default({}),
  routes: z.array(route).default([]),
});

export type AlertmanagerConfig = z.infer<typeof configSchema>;
export type ChannelConfig = z.infer<typeof channel>;

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`invalid pm2-alertmanager configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Webhook URLs are secrets and must not have to sit in module_conf.json, so any string
 * may reference an environment variable as ${NAME}.
 */
export function interpolateEnv(value: unknown, env: NodeJS.ProcessEnv = process.env): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{(\w+)\}/g, (_m, name: string) => env[name] ?? '');
  }
  if (Array.isArray(value)) return value.map((v) => interpolateEnv(v, env));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = interpolateEnv(v, env);
    return out;
  }
  return value;
}

export function parseConfig(raw: unknown, env: NodeJS.ProcessEnv = process.env):
  AlertmanagerConfig {
  const result = configSchema.safeParse(interpolateEnv(raw, env));
  if (result.success) {
    const cfg = result.data;
    // A route naming a channel that does not exist is silent failure at 3am.
    const issues: string[] = [];
    cfg.routes.forEach((r, i) => {
      for (const c of r.channels) {
        if (!cfg.channels[c]) {
          issues.push(`routes.${i}.channels: no channel named "${c}" is defined`);
        }
      }
    });
    if (issues.length > 0) throw new ConfigError(issues);
    return cfg;
  }
  throw new ConfigError(
    result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
  );
}

/** Mask secrets before anything is logged or displayed. */
export function redactConfigForDisplay(cfg: AlertmanagerConfig): unknown {
  const channels: Record<string, unknown> = {};
  for (const [name, c] of Object.entries(cfg.channels)) {
    channels[name] = c.type === 'slack'
      ? { ...c, webhookUrl: '[redacted]' }
      : { ...c, url: '[redacted]', headers: Object.keys(c.headers).length ? '[redacted]' : {} };
  }
  return { ...cfg, channels };
}
