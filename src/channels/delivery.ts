import { Alert } from '../core/alert';
import { Channel, RenderedAlert, DeliveryError } from './types';
import { log } from '../log';
import * as metrics from '../core/metrics';

/**
 * Delivery with retry, backoff, per-channel rate limiting and a dead-letter log.
 *
 * A failing Slack webhook must never crash the module or block the event loop - a module
 * that dies next to healthy apps is worse than the gap it fills.
 */

export interface DeliveryOptions {
  attempts: number;
  baseBackoffMs: number;
  ratePerMinute: number;
}

export const DEFAULT_DELIVERY: DeliveryOptions = {
  attempts: 3,
  baseBackoffMs: 1000,
  ratePerMinute: 20,
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.());

export class Deliverer {
  private windows = new Map<string, number[]>();
  private overflow = new Map<string, number>();

  constructor(private readonly opts: DeliveryOptions = DEFAULT_DELIVERY) {}

  /** Returns false when the channel is over its rate limit for this minute. */
  private allow(channel: string, now: number): boolean {
    const list = this.windows.get(channel) ?? [];
    const cutoff = now - 60_000;
    while (list.length > 0 && (list[0] as number) < cutoff) list.shift();
    this.windows.set(channel, list);
    if (list.length >= this.opts.ratePerMinute) {
      this.overflow.set(channel, (this.overflow.get(channel) ?? 0) + 1);
      return false;
    }
    list.push(now);
    return true;
  }

  /** Drain and clear the "N further alerts suppressed" counter for a channel. */
  takeOverflow(channel: string): number {
    const n = this.overflow.get(channel) ?? 0;
    this.overflow.delete(channel);
    return n;
  }

  async deliver(channel: Channel, alert: Alert, rendered: RenderedAlert): Promise<boolean> {
    if (!this.allow(channel.name, Date.now())) {
      metrics.inc('alertsRateLimited');
      log.warn('channel rate limit reached, alert suppressed', { channel: channel.name });
      return false;
    }

    for (let attempt = 1; attempt <= this.opts.attempts; attempt++) {
      try {
        await channel.send(alert, rendered);
        metrics.inc('alertsSent');
        log.info('alert delivered', {
          channel: channel.name, app: alert.app, condition: alert.kind,
          severity: alert.severity, resolved: rendered.resolved,
        });
        return true;
      } catch (err) {
        const e = err as DeliveryError;
        const retryable = e instanceof DeliveryError ? e.retryable : true;
        const last = attempt === this.opts.attempts || !retryable;

        if (last) {
          metrics.inc('deliveryFailures');
          // Dead letter: the alert is lost, so at minimum it must be in our own log.
          log.error('DEAD LETTER - alert could not be delivered', {
            channel: channel.name,
            app: alert.app,
            condition: alert.kind,
            severity: alert.severity,
            attempts: attempt,
            error: e.message,
            title: rendered.title,
          });
          return false;
        }

        const backoff = this.opts.baseBackoffMs * 2 ** (attempt - 1);
        log.warn('delivery failed, retrying', {
          channel: channel.name, attempt, backoffMs: backoff, error: e.message,
        });
        await sleep(backoff);
      }
    }
    return false;
  }
}
