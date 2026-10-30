import { Alert } from '../core/alert';

export interface RenderedAlert {
  title: string;
  /** Plain-text body, already redacted and size-capped. */
  text: string;
  fields: Record<string, string | number | undefined>;
  logExcerpt: string[];
  resolved: boolean;
}

export interface Channel {
  readonly name: string;
  readonly kind: string;
  send(alert: Alert, rendered: RenderedAlert): Promise<void>;
}

export class DeliveryError extends Error {
  constructor(message: string, public readonly retryable: boolean) {
    super(message);
    this.name = 'DeliveryError';
  }
}
