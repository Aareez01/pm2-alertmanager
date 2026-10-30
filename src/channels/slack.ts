import { Alert } from '../core/alert';
import { Channel, RenderedAlert } from './types';
import { postJson } from './http';

const COLORS: Record<string, string> = {
  info: '#6b7280',
  warning: '#d97706',
  critical: '#dc2626',
  resolved: '#16a34a',
};

export class SlackChannel implements Channel {
  readonly kind = 'slack';

  constructor(
    readonly name: string,
    private readonly webhookUrl: string,
    private readonly timeoutMs = 10_000,
  ) {}

  async send(alert: Alert, r: RenderedAlert): Promise<void> {
    const color = r.resolved ? COLORS.resolved : COLORS[alert.severity];

    const facts = Object.entries(r.fields)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => `*${k}:* ${v}`)
      .join('\n');

    const blocks: unknown[] = [
      { type: 'header', text: { type: 'plain_text', text: r.title.slice(0, 150) } },
      { type: 'section', text: { type: 'mrkdwn', text: facts.slice(0, 2900) } },
    ];

    if (r.logExcerpt.length > 0) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '```' + r.logExcerpt.join('\n').slice(0, 2800) + '```',
        },
      });
    }

    await postJson(
      this.webhookUrl,
      { text: r.title, attachments: [{ color, blocks }] },
      this.timeoutMs,
    );
  }
}
