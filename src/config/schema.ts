import { z } from 'zod';

const severity = z.enum(['info', 'warning', 'critical']);
const condition = z.enum([
  'crash', 'crash-loop', 'operator-stop', 'restart', 'probe-fail', 'recovered',
  'memory-restart',
]);

const slackChannel = z.object({
  type: z.literal('slack'),
  webhookUrl: z.string().min(1),
  timeoutMs: z.number().int().positive().default(10_000),
});

const webhookChannel = z.object({
  type: z.literal('webhook'),
  url: z.string().min(1),
  headers: z.record(z.string(), z.string()).default({}),
  /** Optional JSON template with {{app}}, {{title}}, {{severity}} etc. */
  template: z.string().nullable().default(null),
  timeoutMs: z.number().int().positive().default(10_000),
});

const teamsChannel = z.object({
  type: z.literal('teams'),
  webhookUrl: z.string().min(1),
  timeoutMs: z.number().int().positive().default(10_000),
});

const discordChannel = z.object({
  type: z.literal('discord'),
  webhookUrl: z.string().min(1),
  /** Overrides the webhook's configured name; Discord caps this at 80 characters. */
  username: z.string().nullable().default(null),
  timeoutMs: z.number().int().positive().default(10_000),
});

const telegramChannel = z.object({
  type: z.literal('telegram'),
  botToken: z.string().min(1),
  chatId: z.string().min(1),
  baseUrl: z.string().default('https://api.telegram.org'),
  timeoutMs: z.number().int().positive().default(10_000),
});

const pagerdutyChannel = z.object({
  type: z.literal('pagerduty'),
  routingKey: z.string().min(1),
  baseUrl: z.string().default('https://events.pagerduty.com'),
  timeoutMs: z.number().int().positive().default(10_000),
});

const opsgenieChannel = z.object({
  type: z.literal('opsgenie'),
  apiKey: z.string().min(1),
  baseUrl: z.string().default('https://api.opsgenie.com'),
  timeoutMs: z.number().int().positive().default(10_000),
});

const smtpChannel = z.object({
  type: z.literal('smtp'),
  host: z.string().min(1),
  port: z.number().int().positive().default(587),
  secure: z.boolean().default(false),
  user: z.string().optional(),
  pass: z.string().optional(),
  from: z.string().min(1),
  to: z.array(z.string().min(1)).min(1).max(100),
});

const channel = z.discriminatedUnion('type', [
  slackChannel, webhookChannel, teamsChannel, discordChannel, telegramChannel,
  pagerdutyChannel, opsgenieChannel, smtpChannel,
]);

const route = z.object({
  match: z.object({
    app: z.string().optional(),
    namespace: z.string().optional(),
    severity: severity.optional(),
    condition: z.array(condition).max(50).optional(),
  }).prefault({}),
  channels: z.array(z.string().min(1)).min(1).max(50),
});

const quietHours = z.object({
  enabled: z.boolean().default(false),
  startHour: z.number().int().min(0).max(23).default(22),
  endHour: z.number().int().min(0).max(23).default(7),
  timezone: z.string().default('UTC'),
  alwaysSend: severity.default('critical'),
}).prefault({});

export const configSchema = z.object({
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  startupGraceSeconds: z.number().nonnegative().default(60),
  reconcileSeconds: z.number().positive().default(30),
  resolveAfterSeconds: z.number().positive().default(120),
  stateFile: z.string().default(''),

  detector: z.object({
    /** How long to wait, once an instance is back, for a `restart` event to arrive. */
    settleSeconds: z.number().positive().default(3),
    restartWindowSeconds: z.number().positive().default(30),
    crashLoopThreshold: z.number().int().positive().default(3),
    crashLoopWindowSeconds: z.number().positive().default(60),
  }).prefault({}),

  suppression: z.object({
    /** Events inside this window collapse into one notification. */
    groupWindowSeconds: z.number().positive().default(30),
    dedupWindowSeconds: z.number().positive().default(300),
    crashLoopRenotifySeconds: z.number().positive().default(3600),
    flapThreshold: z.number().int().positive().default(4),
    flapWindowSeconds: z.number().positive().default(600),
    minSeverity: severity.default('warning'),
    quietHours,
  }).prefault({}),

  delivery: z.object({
    attempts: z.number().int().positive().max(10).default(3),
    baseBackoffMs: z.number().int().positive().default(1000),
    ratePerMinute: z.number().int().positive().default(20),
  }).prefault({}),

  /**
   * Detecting memory-triggered restarts requires reading PM2's own daemon log, because
   * max_memory_restart emits nothing on the bus. Opt-in, and best-effort.
   */
  memoryRestarts: z.object({
    enabled: z.boolean().default(false),
    pm2LogPath: z.string().default(''),
    pollSeconds: z.number().positive().default(5),
  }).prefault({}),

  content: z.object({
    logLines: z.number().int().min(0).max(100).default(15),
    maxBytes: z.number().int().positive().default(40_000),
    redactions: z.array(z.object({
      name: z.string(),
      pattern: z.string(),
      replacement: z.string().default('[redacted]'),
    })).max(100).default([]),
  }).prefault({}),

  channels: z.record(z.string(), channel).default({}),
  routes: z.array(route).max(500).default([]),
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
    const masked: Record<string, unknown> = { ...c };
    for (const k of ['webhookUrl', 'url', 'botToken', 'routingKey', 'apiKey', 'pass', 'headers']) {
      if (masked[k] !== undefined) masked[k] = '[redacted]';
    }
    channels[name] = masked;
  }
  return { ...cfg, channels };
}
