import { Alert } from '../core/alert';
import { Channel, RenderedAlert } from './types';
import { postJson } from './http';

/** Discord wants a 24-bit integer, not a CSS colour string. */
const COLORS: Record<string, number> = {
  info: 0x6b7280,
  warning: 0xd97706,
  critical: 0xdc2626,
  resolved: 0x16a34a,
};

/**
 * Discord's documented hard limits. These are not style guidance: exceeding any one of
 * them is a 400, and `postJson` quite rightly does not retry a 4xx. An over-long log
 * line would therefore lose the alert outright rather than merely truncate it, so every
 * value is clamped on the way out.
 */
const TITLE_MAX = 256;
const FIELD_NAME_MAX = 256;
const FIELD_VALUE_MAX = 1024;
const FIELDS_MAX = 25;
const DESCRIPTION_MAX = 4096;
const USERNAME_MAX = 80;

/** Discord incoming webhook. Replies 204 with no body on success. */
export class DiscordChannel implements Channel {
  readonly kind = 'discord';

  constructor(
    readonly name: string,
    private readonly webhookUrl: string,
    private readonly username: string | null = null,
    private readonly timeoutMs = 10_000,
  ) {}

  async send(alert: Alert, r: RenderedAlert): Promise<void> {
    const fields = Object.entries(r.fields)
      .filter(([, v]) => v !== undefined && v !== '')
      .slice(0, FIELDS_MAX)
      .map(([k, v]) => ({
        name: k.slice(0, FIELD_NAME_MAX),
        value: String(v).slice(0, FIELD_VALUE_MAX),
        inline: true,
      }));

    const embed: Record<string, unknown> = {
      title: r.title.slice(0, TITLE_MAX),
      color: r.resolved ? COLORS.resolved : COLORS[alert.severity],
      fields,
      timestamp: new Date(alert.lastAt).toISOString(),
    };

    if (r.logExcerpt.length > 0) {
      // Fenced so Discord does not read log output as markdown. A stack trace that
      // happens to contain a fence would otherwise close ours early and leave the rest
      // of the excerpt formatted as prose, so the sequence is broken up first.
      const body = r.logExcerpt.join('\n').replace(/```/g, '`​``');
      const fence = '```\n';
      embed.description = fence + body.slice(0, DESCRIPTION_MAX - fence.length - 4) + '\n```';
    }

    await postJson(this.webhookUrl, {
      ...(this.username ? { username: this.username.slice(0, USERNAME_MAX) } : {}),
      // An alert body carries application output, and Discord resolves @everyone in
      // anything it is handed. One log line is all it takes to page an entire server at
      // 3am over someone else's stack trace, so mentions are disabled rather than
      // escaped - nothing this module sends has any reason to ping.
      allowed_mentions: { parse: [] },
      embeds: [embed],
    }, this.timeoutMs);
  }
}
