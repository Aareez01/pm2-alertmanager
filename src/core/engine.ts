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
import { TeamsChannel } from '../channels/teams';
import { TelegramChannel } from '../channels/telegram';
import { PagerDutyChannel } from '../channels/pagerduty';
import { OpsgenieChannel } from '../channels/opsgenie';
import { SmtpChannel } from '../channels/smtp';
import { Deliverer } from '../channels/delivery';
import { render } from '../content/render';
import { compileRules } from '../content/redact';
import { defaultStatePath, loadState, saveState } from './state';
import { MemoryRestartWatcher, defaultPm2LogPath } from './memoryWatcher';
import { inQuietHours } from './suppressor';
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
  private memoryWatcher: MemoryRestartWatcher | null = null;
  private lastList: Pm2Process[] = [];
  /** Alerts withheld during quiet hours, summarised when the window ends. */
  private held: Alert[] = [];
  private wasQuiet = false;

  constructor(
    private readonly client: Pm2Client,
    private config: AlertmanagerConfig,
  ) {
    this.detector = new Detector({
      settleMs: config.detector.settleSeconds * 1000,
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
      switch (c.type) {
        case 'slack':
          this.channels.set(name, new SlackChannel(name, c.webhookUrl, c.timeoutMs)); break;
        case 'webhook':
          this.channels.set(name,
            new WebhookChannel(name, c.url, c.headers, c.template, c.timeoutMs)); break;
        case 'teams':
          this.channels.set(name, new TeamsChannel(name, c.webhookUrl, c.timeoutMs)); break;
        case 'telegram':
          this.channels.set(name,
            new TelegramChannel(name, c.botToken, c.chatId, c.baseUrl, c.timeoutMs)); break;
        case 'pagerduty':
          this.channels.set(name,
            new PagerDutyChannel(name, c.routingKey, c.baseUrl, c.timeoutMs)); break;
        case 'opsgenie':
          this.channels.set(name,
            new OpsgenieChannel(name, c.apiKey, c.baseUrl, c.timeoutMs)); break;
        case 'smtp':
          this.channels.set(name, new SmtpChannel(name, {
            host: c.host, port: c.port, secure: c.secure, user: c.user,
            pass: c.pass, from: c.from, to: c.to,
          })); break;
      }
    }
  }

  async start(): Promise<void> {
    this.suppressor.restore(loadState(this.statePath)?.suppressor);

    // Reconcile against reality BEFORE subscribing, then let startup suppression cover
    // the start/online storm that a daemon restart produces. This also primes the
    // process list that exit classification and memory alerts both read.
    await this.reconcile();

    this.bus = await this.client.launchBus();
    this.bus.on('process:event', (p) => this.onBusEvent(normalizeProcessEvent(p)));
    this.bus.on(PROBE_STATUS_EVENT, (p) => this.onProbeEvent(p));

    this.every(1000, () => this.drain());
    this.every(1000, () =>
      this.emitConditions(this.detector.tick(Date.now(), (app, pmId) => {
        const p = this.lastList.find(
          (x) => x.name === app && (x.pm_id ?? x.pm2_env?.pm_id) === pmId);
        if (!p) return null;
        // PM2 defaults autorestart to true; only an explicit false disables it.
        return { autorestart: p.pm2_env?.autorestart !== false };
      })));
    this.every(this.config.reconcileSeconds * 1000, () => void this.reconcile());
    this.every(30_000, () => this.persist());
    this.every(5_000, () => this.checkQuietWindow());

    if (this.config.memoryRestarts.enabled) {
      this.memoryWatcher = new MemoryRestartWatcher(
        this.config.memoryRestarts.pm2LogPath || defaultPm2LogPath());
      this.every(this.config.memoryRestarts.pollSeconds * 1000,
        () => void this.pollMemoryRestarts());
      log.info('memory-restart detection enabled (best-effort, reads PM2 daemon log)');
    }

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
        'ignoring pm2-liveness:status with unsupported contract version', { v: ev.probe.v });
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
    if (decision.hold === true && decision.reason === 'quiet-hours') {
      // Held, not dropped: summarised when the quiet window ends.
      if (this.held.length < 500) this.held.push(alert);
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

    this.lastList = list;
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
        const st = p.pm2_env?.status;
        // 'errored' means PM2 tried and gave up - always an incident.
        if (st === 'errored') return true;
        // 'stopped' is ambiguous, and reconciliation is the second door into the same
        // decision the detector makes from the bus, so it must use the same rule:
        // PM2 would have restarted this unless it was asked not to.
        if (st === 'stopped') return p.pm2_env?.autorestart === false;
        return false;
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

  /**
   * Quiet hours hold sub-threshold alerts rather than dropping them; when the window
   * ends, everything held goes out as a single digest.
   *
   * Startup-grace holds are deliberately NOT summarised - those are the start/online
   * storm from a daemon restart, and anything genuinely broken is picked up by
   * reconciliation instead.
   */
  private checkQuietWindow(): void {
    const now = Date.now();
    const nowQuiet = inQuietHours(this.config.suppression.quietHours, now);
    if (this.wasQuiet && !nowQuiet && this.held.length > 0) {
      const held = this.held;
      this.held = [];
      void this.sendDigest(held, now);
    }
    this.wasQuiet = nowQuiet;
  }

  private async sendDigest(held: Alert[], now: number): Promise<void> {
    const byApp = new Map<string, number>();
    for (const a of held) byApp.set(a.app, (byApp.get(a.app) ?? 0) + a.count);
    const summary = [...byApp.entries()]
      .sort((x, y) => y[1] - x[1])
      .map(([app, n]) => `${app}: ${n}`)
      .join(', ');

    const digest: Alert = {
      fingerprint: `digest:${now}`,
      groupKey: 'digest',
      kind: 'crash',
      severity: 'warning',
      app: 'quiet-hours digest',
      pmIds: [],
      host: HOST,
      firstAt: Math.min(...held.map((a) => a.firstAt)),
      lastAt: now,
      count: held.length,
      detail: { digest: true, heldAlerts: held.length, summary },
    };
    log.info('quiet hours ended, sending digest', { heldAlerts: held.length, summary });
    await this.dispatch(digest, false);
  }

  private async pollMemoryRestarts(): Promise<void> {
    if (!this.memoryWatcher) return;
    const hits = await this.memoryWatcher.poll();
    if (hits.length === 0) return;

    // The cached list can predate the process we just saw restart, which would name the
    // alert "pm_id 7" instead of the app. Refresh once before naming anything.
    const known = (id: number) =>
      this.lastList.find((p) => (p.pm_id ?? p.pm2_env?.pm_id) === id);
    if (hits.some((h) => !known(h.pmId))) {
      try {
        this.lastList = await this.client.list();
      } catch {
        /* keep the stale list rather than dropping the alert */
      }
    }

    for (const hit of hits) {
      const proc = known(hit.pmId);
      const app = proc?.name ?? `pm_id ${hit.pmId}`;
      this.consider(alertFrom({
        kind: 'memory-restart',
        severity: 'warning',
        app,
        pmId: hit.pmId,
        namespace: proc?.pm2_env?.namespace,
        at: Date.now(),
        detail: {
          currentMemoryBytes: hit.currentMemory,
          limitBytes: hit.limit,
          currentMemoryMb: Math.round(hit.currentMemory / 1048576),
          limitMb: Math.round(hit.limit / 1048576),
          errLogPath: proc?.pm2_env?.pm_err_log_path,
        },
      }, HOST));
    }
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
