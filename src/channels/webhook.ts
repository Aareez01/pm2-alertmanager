import { Alert } from '../core/alert';
import { Channel, RenderedAlert } from './types';
import { postJson } from './http';

/**
 * Generic JSON webhook. Covers Teams, Discord, and anything else with an incoming hook,
 * which is why native integrations for those are not in v1.
 */
export class WebhookChannel implements Channel {
  readonly kind = 'webhook';

  constructor(
    readonly name: string,
    private readonly url: string,
    private readonly headers: Record<string, string> = {},
    private readonly template: string | null = null,
    private readonly timeoutMs = 10_000,
  ) {}

  async send(alert: Alert, r: RenderedAlert): Promise<void> {
    const payload = this.template
      ? JSON.parse(interpolate(this.template, alert, r))
      : {
          title: r.title,
          text: r.text,
          resolved: r.resolved,
          severity: alert.severity,
          condition: alert.kind,
          app: alert.app,
          pm_ids: alert.pmIds,
          namespace: alert.namespace,
          host: alert.host,
          count: alert.count,
          first_at: new Date(alert.firstAt).toISOString(),
          last_at: new Date(alert.lastAt).toISOString(),
          fields: r.fields,
          log_excerpt: r.logExcerpt,
        };

    await postJson(this.url, payload, this.timeoutMs, this.headers);
  }
}

function interpolate(template: string, alert: Alert, r: RenderedAlert): string {
  const vars: Record<string, string> = {
    title: r.title,
    text: r.text,
    app: alert.app,
    severity: alert.severity,
    condition: alert.kind,
    host: alert.host,
    pm_ids: alert.pmIds.join(','),
    count: String(alert.count),
    resolved: String(r.resolved),
  };
  // JSON.stringify each value so the result stays valid JSON.
  return template.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => {
    const v = vars[k] ?? '';
    const s = JSON.stringify(v);
    return s.slice(1, -1);
  });
}
