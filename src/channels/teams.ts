import { Alert } from '../core/alert';
import { Channel, RenderedAlert } from './types';
import { postJson } from './http';

const COLORS: Record<string, string> = {
  info: '6B7280', warning: 'D97706', critical: 'DC2626', resolved: '16A34A',
};

/** Microsoft Teams incoming webhook (legacy MessageCard - still what webhooks accept). */
export class TeamsChannel implements Channel {
  readonly kind = 'teams';

  constructor(
    readonly name: string,
    private readonly webhookUrl: string,
    private readonly timeoutMs = 10_000,
  ) {}

  async send(alert: Alert, r: RenderedAlert): Promise<void> {
    const facts = Object.entries(r.fields)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => ({ name: k, value: String(v) }));

    const sections: Record<string, unknown>[] = [{ facts, markdown: false }];
    if (r.logExcerpt.length > 0) {
      sections.push({ text: '<pre>' + r.logExcerpt.join('\n')
        .replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] as string))
        .slice(0, 2500) + '</pre>', markdown: false });
    }

    await postJson(this.webhookUrl, {
      '@type': 'MessageCard',
      '@context': 'https://schema.org/extensions',
      themeColor: r.resolved ? COLORS.resolved : COLORS[alert.severity],
      summary: r.title.slice(0, 150),
      title: r.title.slice(0, 150),
      sections,
    }, this.timeoutMs);
  }
}
