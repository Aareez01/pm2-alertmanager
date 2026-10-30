import { Pm2Process } from './types';
import { log } from '../log';

/**
 * Thin promisified wrapper over the `pm2` package.
 *
 * `pm2` is a peerDependency rather than a dependency: the host already has PM2 installed
 * (that is the only way this module runs at all), and depending on it directly would pull
 * PM2's whole tree into ours for no benefit - see NFR-3.
 */

interface Pm2Api {
  connect(cb: (err: Error | null) => void): void;
  disconnect(): void;
  list(cb: (err: Error | null, list: Pm2Process[]) => void): void;
  restart(id: number | string, cb: (err: Error | null) => void): void;
  launchBus(cb: (err: Error | null, bus: Pm2Bus) => void): void;
}

export interface Pm2Bus {
  on(event: string, handler: (payload: unknown) => void): void;
  close?(): void;
}

function resolvePm2(): Pm2Api {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('pm2') as Pm2Api;
  } catch (err) {
    throw new Error(
      'could not require("pm2"). pm2-alertmanager is a PM2 module and needs the pm2 package ' +
        'resolvable from its install directory. Original error: ' + (err as Error).message,
    );
  }
}

export class Pm2Client {
  private api: Pm2Api | null = null;

  async connect(): Promise<void> {
    const api = resolvePm2();
    await new Promise<void>((resolve, reject) =>
      api.connect((err) => (err ? reject(err) : resolve())),
    );
    this.api = api;
  }

  disconnect(): void {
    try {
      this.api?.disconnect();
    } catch {
      /* shutting down anyway */
    }
  }

  async list(): Promise<Pm2Process[]> {
    const api = this.require();
    return new Promise((resolve, reject) =>
      api.list((err, list) => (err ? reject(err) : resolve(list ?? []))),
    );
  }

  /** Restart a single instance by pm_id. Never throws - a failed restart is logged. */
  async restart(pmId: number): Promise<boolean> {
    const api = this.require();
    return new Promise((resolve) =>
      api.restart(pmId, (err) => {
        if (err) {
          log.error('restart failed', { pm_id: pmId, error: err.message });
          return resolve(false);
        }
        resolve(true);
      }),
    );
  }

  /**
   * The bus is fire-and-forget: no delivery guarantee, no replay. A subscriber that is
   * down misses events permanently, which is why this module also reconciles against
   * pm2.list() rather than trusting the bus alone.
   */
  async launchBus(): Promise<Pm2Bus> {
    const api = this.require();
    return new Promise((resolve, reject) =>
      api.launchBus((err, bus) => (err ? reject(err) : resolve(bus))),
    );
  }

  private require(): Pm2Api {
    if (!this.api) throw new Error('pm2 client not connected');
    return this.api;
  }
}
