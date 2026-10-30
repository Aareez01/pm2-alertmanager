import { hostname } from 'node:os';
import { AlertmanagerConfig } from '../config/schema';
import { Pm2Client, Pm2Bus } from '../pm2/client';
import { Pm2Process, isModule } from '../pm2/types';
import { normalizeProcessEvent, normalizeProbeEvent, NormalizedEvent } from '../events/normalize';
import { PROBE_STATUS_EVENT, isSupportedVersion } from '../events/contract';
import { Detector, Condition } from './detector';
import { Alert, alertFrom, mergeGroup } from './alert';
import { Suppressor } from './suppressor';
import { route as routeAlert } from './router';
import { Channel } from '../channels/types';
import { SlackChannel } from '../channels/slack';
import { WebhookChannel } from '../channels/webhook';
import { Deliverer } from '../channels/delivery';
import { render } from '../content/render';
import { compileRules } from '../content/redact';
import { defaultStatePath, loadState, saveState } from './state';
import { log, logOnce } from '../log';
import * as metrics from './metrics';

const HOST = hostname();
const MAX_QUEUE = 1000;

interface ActiveAlert {
  alert: Alert;
  lastConditionAt: number;
}

export class Engine {
  private detector: Detector;
  private suppressor: Suppressor;
  private deliverer: Deliverer;
  private channels = new Map<string, Channel>();
  private group = new Map<string, Alert[]>();
  private groupTimer: NodeJS.Timeout | null = null;
  private active = new Map<string, ActiveAlert>();
  private queue: NormalizedEvent[] = [];
  private timers: NodeJS.Timeout[] = [];
  private bus: Pm2Bus | null = null;
  private readonly statePath: string;
  private readonly bootAt = Date.now();

  constructor(
    private readonly client: Pm2Client,
    private config: AlertmanagerConfig,
  ) {
    this.detector = new Detector({
      restartWindowMs: config.detector.restartWindowSeconds * 1000,
      crashLoopThreshold: config.detector.crashLoopThreshold,
      crashLoopWindowMs: config.detector.crashLoopWindowSeconds * 1000,
    });
    this.suppressor = new Suppressor({
      startupGraceMs: config.startupGraceSeconds * 1000,
      dedupWindowMs: config.suppression.dedupWindowSeconds * 1000,
      crashLoopRenotifyMs: config.suppression.crashLoopRenotifySeconds * 1000,
      flapThreshold: config.suppression.flapThreshold,
      flapWindowMs: config.suppression.flapWindowSeconds * 1000,
      minSeverity: config.suppression.minSeverity,
      quietHours: config.suppression.quietHours,
    }, this.bootAt);
    this.deliverer = new Deliverer(config.delivery);
    this.statePath = config.stateFile || defaultStatePath();
    this.buildChannels();
  }

  private buildChannels(): void {
    this.channels.clear();
    for (const [name, c] of Object.entries(this.config.channels)) {
      if (c.type === 'slack') {
        this.channels.set(name, new SlackChannel(name, c.webhookUrl, c.timeoutMs));
      } else {
        this.channels.set(name, new WebhookChannel(name, c.url, c.headers, c.template, c.timeoutMs));
      }
    }
  }

  async start(): Promise<void> {
    this.suppressor.restore(loadState(this.statePath)?.suppressor);

    // Reconcile against reality BEFORE subscribing, then let startup suppression cover
    // the start/online storm that a daemon restart produces.
    await this.reconcile();

    this.bus = await this.client.launchBus();
    this.bus.on('process:event', (p) => this.onBusEvent(normalizeProcessEvent(p)));
    this.bus.on(PROBE_STATUS_EVENT, (p) => this.onProbeEvent(p));

    this.every(1000, () => this.drain());
    this.every(5000, () => this.emitConditions(this.detector.tick()));
    this.every(this.config.reconcileSeconds * 1000, () => void this.reconcile());
    this.every(30_000, () => this.persist());

    log.info('pm2-alertmanager started', {
      channels: this.channels.size,
      routes: this.config.routes.length,
      startupGraceSeconds: this.config.startupGraceSeconds,
    });
  }

  private every(ms: number, fn: () => void): void {
    const t = setInterval(() => {
      try { fn(); } catch (err) {
        log.error('scheduled task failed', { error: (err as Error).message });
      }
    }, ms);
    t.unref?.();
    this.timers.push(t);
  }

  private onBusEvent(ev: NormalizedEvent | null): void {
    if (!ev) return;
    metrics.inc('eventsReceived');
    this.enqueue(ev);
  }

  private onProbeEvent(payload: unknown): void {
    const ev = normalizeProbeEvent(payload);
    if (!ev || !ev.probe) return;
    metrics.inc('eventsReceived');
    if (!isSupportedVersion(ev.probe)) {
      metrics.inc('unknownContractVersions');
      logOnce(`contract:v${ev.probe.v}`, 'warn',
        'ignoring pm2-probe:status with unsupported contract version', { v: ev.probe.v });
      return;
    }
    this.enqueue(ev);
  }

  /** Bounded: under a flood we drop the oldest and record it rather than growing. */
  private enqueue(ev: NormalizedEvent): void {
    if (this.queue.length >= MAX_QUEUE) {
      this.queue.shift();
      metrics.inc('eventsDropped');
    }
    this.queue.push(ev);
    metrics.set('queueDepth', this.queue.length);
  }

  private drain(): void {
    const batch = this.queue.splice(0, this.queue.length);
    metrics.set('queueDepth', 0);
    const conditions: Condition[] = [];
    for (const ev of batch) {
      // Never alert on ourselves or other PM2 modules.
      conditions.push(...this.detector.ingest(ev));
    }
    this.emitConditions(conditions);
  }

  private emitConditions(conditions: Condition[]): void {
    for (const c of conditions) {
      metrics.inc('conditionsDetected');
      if (c.kind === 'recovered') {
        this.suppressor.noteRecovered(c.app);
        continue;
      }
      if (c.kind === 'crash' || c.kind === 'crash-loop' || c.kind === 'probe-fail') {
        if (this.suppressor.noteTransition(c.app, c.at)) {
          log.warn('app is flapping', { app: c.app });
        }
      }
      this.consider(alertFrom(c, HOST));
    }
  }

  private consider(alert: Alert): void {
    const now = Date.now();
    const decision = this.suppressor.evaluate(alert, now);
    if (!decision.send) {
      metrics.inc('alertsSuppressed');
      // Every silence is explainable after the fact - "why didn't I get paged?"
      log.debug('alert suppressed', {
        app: alert.app, condition: alert.kind, severity: alert.severity,
        reason: decision.reason, held: decision.hold === true,
      });
      return;
    }
    const bucket = this.group.get(alert.groupKey) ?? [];
    bucket.push(alert);
    this.group.set(alert.groupKey, bucket);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.groupTimer) return;
    const ms = this.config.suppression.groupWindowSeconds * 1000;
    this.groupTimer = setTimeout(() => {
      this.groupTimer = null;
      void this.flush();
    }, ms);
    this.groupTimer.unref?.();
  }

  private async flush(): Promise<void> {
    const groups = [...this.group.entries()];
    this.group.clear();
    for (const [, alerts] of groups) {
      if (alerts.length === 0) continue;
      const merged = mergeGroup(alerts);
      await this.dispatch(merged, false);
      this.suppressor.noteSent(merged, Date.now());
      this.active.set(merged.app, { alert: merged, lastConditionAt: merged.lastAt });
      metrics.set('activeAlerts', this.active.size);
    }
  }

  private async dispatch(alert: Alert, resolved: boolean): Promise<void> {
    const names = routeAlert(this.config.routes, alert);
    if (names.length === 0) {
      logOnce(`noroute:${alert.app}:${alert.kind}`, 'warn',
        'alert matched no route and was not sent', { app: alert.app, condition: alert.kind });
      return;
    }
    const rendered = await render(alert, {
      logLines: this.config.content.logLines,
      rules: compileRules(this.config.content.redactions),
      maxBytes: this.config.content.maxBytes,
    }, resolved);

    for (const name of names) {
      const ch = this.channels.get(name);
      if (!ch) continue;
      const overflow = this.deliverer.takeOverflow(name);
      if (overflow > 0) {
        log.warn('alerts were suppressed by the channel rate limit', { channel: name, count: overflow });
      }
      await this.deliverer.deliver(ch, alert, rendered);
    }
  }

  /**
   * The bus is fire-and-forget, so anything that happened while we were down was missed
   * entirely - including during the restart that our own `pm2 set` triggers. Reconciling
   * against pm2.list() is what makes missed events recoverable.
   */
  async reconcile(): Promise<void> {
    let list: Pm2Process[];
    try {
      list = await this.client.list();
    } catch (err) {
      log.warn('pm2 list failed during reconcile', { error: (err as Error).message });
      return;
    }

    const byApp = new Map<string, Pm2Process[]>();
    for (const p of list) {
      if (isModule(p) || !p.name) continue;
      const arr = byApp.get(p.name) ?? [];
      arr.push(p);
      byApp.set(p.name, arr);
    }

    const now = Date.now();
    for (const [app, procs] of byApp) {
      const down = procs.filter((p) => {
        const s = p.pm2_env?.status;
        return s === 'errored' || s === 'stopped';
      });
      const activeEntry = this.active.get(app);

      if (down.length > 0 && !activeEntry) {
        // Missed while we were not listening.
        const pmIds = down.map((p) => p.pm_id ?? p.pm2_env?.pm_id).filter(
          (n): n is number => typeof n === 'number');
        const alert: Alert = {
          fingerprint: `${app}:reconcile:down`,
          groupKey: `${app}:crash`,
          kind: 'crash',
          severity: 'warning',
          app,
          pmIds,
          namespace: down[0]?.pm2_env?.namespace,
          host: HOST,
          firstAt: now,
          lastAt: now,
          count: down.length,
          detail: {
            source: 'reconciliation',
            note: 'found down via pm2 list, not via the bus',
            errLogPath: down[0]?.pm2_env?.pm_err_log_path,
          },
        };
        const decision = this.suppressor.evaluate(alert, now);
        if (decision.send) {
          await this.dispatch(alert, false);
          this.suppressor.noteSent(alert, now);
          this.active.set(app, { alert, lastConditionAt: now });
        }
        continue;
      }

      if (down.length === 0 && activeEntry) {
        const quietFor = now - activeEntry.lastConditionAt;
        if (quietFor >= this.config.resolveAfterSeconds * 1000) {
          await this.dispatch(activeEntry.alert, true);
          this.active.delete(app);
          this.suppressor.noteRecovered(app);
          log.info('incident resolved', { app, quietForSeconds: Math.round(quietFor / 1000) });
        }
      }
    }
    metrics.set('activeAlerts', this.active.size);
  }

  /** `pm2 trigger pm2-alertmanager test-alert` - verify routing without breaking anything. */
  async testAlert(): Promise<void> {
    const now = Date.now();
    const alert: Alert = {
      fingerprint: `test:${now}`, groupKey: 'test', kind: 'crash', severity: 'critical',
      app: 'pm2-alertmanager-test', pmIds: [0], host: HOST,
      firstAt: now, lastAt: now, count: 1,
      detail: { note: 'synthetic test alert - nothing is actually wrong' },
    };
    log.info('sending test alert through every configured route');
    for (const [name, ch] of this.channels) {
      const rendered = await render(alert, {
        logLines: 0, rules: compileRules(), maxBytes: this.config.content.maxBytes,
      });
      await this.deliverer.deliver(ch, alert, rendered).catch(() => undefined);
      log.info('test alert attempted', { channel: name });
    }
  }

  persist(): void {
    saveState(this.statePath, {
      version: 1,
      savedAt: Date.now(),
      suppressor: this.suppressor.snapshot(),
      active: [...this.active.entries()].map(([app, a]) => [app, {
        firstAt: a.alert.firstAt, lastAt: a.alert.lastAt, severity: a.alert.severity,
        kind: a.alert.kind, app: a.alert.app, pmIds: a.alert.pmIds,
      }]),
    });
  }

  updateConfig(next: AlertmanagerConfig): void {
    this.config = next;
    this.buildChannels();
    log.info('configuration applied', { channels: this.channels.size, routes: next.routes.length });
  }

  stop(): void {
    this.persist();
    for (const t of this.timers) clearInterval(t);
    if (this.groupTimer) clearTimeout(this.groupTimer);
    this.bus?.close?.();
  }
}
