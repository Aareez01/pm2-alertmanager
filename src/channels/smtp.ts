import { Alert } from '../core/alert';
import { Channel, RenderedAlert } from './types';
import { DeliveryError } from './types';

/**
 * Email via nodemailer.
 *
 * nodemailer is an OPTIONAL peer dependency, loaded lazily: most installs route to chat
 * or a webhook, and nobody should download an SMTP stack to use Slack. If it is missing
 * the error says exactly what to install rather than failing obscurely at startup.
 */
export interface SmtpOptions {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
  to: string[];
}

interface Transport {
  sendMail(opts: Record<string, unknown>): Promise<unknown>;
}

export class SmtpChannel implements Channel {
  readonly kind = 'smtp';
  private transport: Transport | null = null;

  constructor(readonly name: string, private readonly opts: SmtpOptions) {}

  private getTransport(): Transport {
    if (this.transport) return this.transport;
    let nodemailer: { createTransport(o: unknown): Transport };
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      nodemailer = require('nodemailer');
    } catch {
      throw new DeliveryError(
        'the smtp channel requires nodemailer, which is an optional dependency. ' +
          'Install it alongside this module: npm install nodemailer',
        false,
      );
    }
    this.transport = nodemailer.createTransport({
      host: this.opts.host,
      port: this.opts.port,
      secure: this.opts.secure,
      ...(this.opts.user ? { auth: { user: this.opts.user, pass: this.opts.pass } } : {}),
    });
    return this.transport;
  }

  async send(alert: Alert, r: RenderedAlert): Promise<void> {
    const subject = `[${r.resolved ? 'RESOLVED' : alert.severity.toUpperCase()}] ${r.title}`;
    await this.getTransport().sendMail({
      from: this.opts.from,
      to: this.opts.to.join(', '),
      subject: subject.slice(0, 200),
      text: r.text,
    });
  }
}
