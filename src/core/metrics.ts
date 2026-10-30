/** Internal counters, published through @pm2/io when available (optional dependency). */

export const counters = {
  eventsReceived: 0,
  conditionsDetected: 0,
  alertsSent: 0,
  alertsSuppressed: 0,
  alertsRateLimited: 0,
  deliveryFailures: 0,
  activeAlerts: 0,
  queueDepth: 0,
  eventsDropped: 0,
  unknownContractVersions: 0,
};

export type CounterName = keyof typeof counters;

export function inc(name: CounterName, by = 1): void { counters[name] += by; }
export function set(name: CounterName, value: number): void { counters[name] = value; }

export function registerMetrics(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const io = require('@pm2/io');
    for (const key of Object.keys(counters) as CounterName[]) {
      io.metric({ name: `alertmanager.${key}`, value: () => counters[key] });
    }
  } catch {
    // Optional - counters still work, they just aren't published to pm2 monit.
  }
}
