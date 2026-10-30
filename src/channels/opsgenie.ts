import { Alert } from '../core/alert';
import { Channel, RenderedAlert } from './types';
import { postJson } from './http';

const PRIORITY: Record<string, string> = {
  info: 'P5', warning: 'P3', critical: 'P1',
};

/** Opsgenie Alerts API v2. The alert fingerprint is used as the alias, so a resolution
 *  closes the same alert rather than creating another. */
export class OpsgenieChannel implements Channel {
  readonly kind = 'opsgenie';

  constructor(
    readonly name: string,
    private readonly apiKey: string,
    private readonly baseUrl = 'https://api.opsgenie.com',
    private readonly timeoutMs = 10_000,
  ) {}

  async send(alert: Alert, r: RenderedAlert): Promise<void> {
    const headers = { authorization: `GenieKey ${this.apiKey}` };
    const alias = alert.fingerprint;

    if (r.resolved) {
      await postJson(
        `${this.baseUrl}/v2/alerts/${encodeURIComponent(alias)}/close?identifierType=alias`,
        { note: 'resolved by pm2-alertmanager' },
        this.timeoutMs,
        headers,
      );
      return;
    }

    await postJson(`${this.baseUrl}/v2/alerts`, {
      message: r.title.slice(0, 130),
      alias,
      description: r.text.slice(0, 15000),
      priority: PRIORITY[alert.severity] ?? 'P3',
      source: alert.host,
      entity: alert.app,
      tags: [alert.kind, alert.severity, `host:${alert.host}`],
      details: Object.fromEntries(
        Object.entries(r.fields).filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, String(v)]),
      ),
    }, this.timeoutMs, headers);
  }
}
