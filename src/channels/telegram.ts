import { Alert } from '../core/alert';
import { Channel, RenderedAlert } from './types';
import { postJson } from './http';

const ICON: Record<string, string> = {
  info: 'INFO', warning: 'WARNING', critical: 'CRITICAL', resolved: 'RESOLVED',
};

function escapeHtml(s: string): string {
  return s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] as string));
}

export class TelegramChannel implements Channel {
  readonly kind = 'telegram';

  constructor(
    readonly name: string,
    private readonly botToken: string,
    private readonly chatId: string,
    /** Override for a self-hosted Bot API server. */
    private readonly baseUrl = 'https://api.telegram.org',
    private readonly timeoutMs = 10_000,
  ) {}

  async send(alert: Alert, r: RenderedAlert): Promise<void> {
    const label = r.resolved ? ICON.resolved : ICON[alert.severity];
    const facts = Object.entries(r.fields)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => `${escapeHtml(k)}: <b>${escapeHtml(String(v))}</b>`)
      .join('\n');

    let text = `<b>[${label}] ${escapeHtml(r.title)}</b>\n\n${facts}`;
    if (r.logExcerpt.length > 0) {
      text += `\n\n<pre>${escapeHtml(r.logExcerpt.join('\n')).slice(0, 2000)}</pre>`;
    }

    await postJson(
      `${this.baseUrl}/bot${this.botToken}/sendMessage`,
      { chat_id: this.chatId, text: text.slice(0, 4000), parse_mode: 'HTML',
        disable_web_page_preview: true },
      this.timeoutMs,
    );
  }
}
