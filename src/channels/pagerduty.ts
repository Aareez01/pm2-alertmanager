import { Alert } from '../core/alert';
import { Channel, RenderedAlert } from './types';
import { postJson } from './http';

const SEVERITY: Record<string, string> = {
  info: 'info', warning: 'warning', critical: 'critical',
};

/**
 * PagerDuty Events API v2.
 *
 * Uses the alert fingerprint as `dedup_key`, so PagerDuty groups repeats into one
 * incident and a resolution notice closes that same incident rather than opening a new
 * one. This is why resolution tracking exists at all.
 */
export class PagerDutyChannel implements Channel {
  readonly kind = 'pagerduty';

  constructor(
    readonly name: string,
    private readonly routingKey: string,
    /** EU accounts use https://events.eu.pagerduty.com */
    private readonly baseUrl = 'https://events.pagerduty.com',
    private readonly timeoutMs = 10_000,
  ) {}

  async send(alert: Alert, r: RenderedAlert): Promise<void> {
    const body = r.resolved
      ? {
          routing_key: this.routingKey,
          event_action: 'resolve',
          dedup_key: alert.fingerprint,
        }
      : {
          routing_key: this.routingKey,
          event_action: 'trigger',
          dedup_key: alert.fingerprint,
          payload: {
            summary: r.title.slice(0, 1024),
            severity: SEVERITY[alert.severity] ?? 'warning',
            source: alert.host,
            component: alert.app,
            group: alert.namespace ?? 'default',
            class: alert.kind,
            custom_details: { ...r.fields, stderr: r.logExcerpt.join('\n').slice(0, 4000) },
          },
        };

    await postJson(`${this.baseUrl}/v2/enqueue`, body, this.timeoutMs);
  }
}
