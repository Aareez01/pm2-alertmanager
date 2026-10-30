import { Condition, ConditionKind, Severity } from './detector';

export interface Alert {
  /** Identity for deduplication: one app, one instance, one kind of problem. */
  fingerprint: string;
  /** Identity for grouping: four instances crashing is one message, not four. */
  groupKey: string;
  kind: ConditionKind;
  severity: Severity;
  app: string;
  pmIds: number[];
  namespace?: string;
  host: string;
  firstAt: number;
  lastAt: number;
  /** How many occurrences this alert represents after dedup/grouping. */
  count: number;
  detail: Record<string, unknown>;
}

export function fingerprintOf(c: Condition): string {
  return `${c.app}:${c.pmId}:${c.kind}`;
}

export function groupKeyOf(c: Condition): string {
  return `${c.app}:${c.kind}`;
}

export function alertFrom(c: Condition, host: string): Alert {
  return {
    fingerprint: fingerprintOf(c),
    groupKey: groupKeyOf(c),
    kind: c.kind,
    severity: c.severity,
    app: c.app,
    pmIds: [c.pmId],
    namespace: c.namespace,
    host,
    firstAt: c.at,
    lastAt: c.at,
    count: 1,
    detail: c.detail,
  };
}

/** Merge alerts sharing a groupKey into one notification. */
export function mergeGroup(alerts: Alert[]): Alert {
  const first = alerts[0] as Alert;
  const pmIds = [...new Set(alerts.flatMap((a) => a.pmIds))].sort((x, y) => x - y);
  return {
    ...first,
    pmIds,
    firstAt: Math.min(...alerts.map((a) => a.firstAt)),
    lastAt: Math.max(...alerts.map((a) => a.lastAt)),
    count: alerts.reduce((n, a) => n + a.count, 0),
  };
}

export const SEVERITY_ORDER: Record<Severity, number> = {
  info: 10,
  warning: 20,
  critical: 30,
};

export function atLeast(a: Severity, floor: Severity): boolean {
  return SEVERITY_ORDER[a] >= SEVERITY_ORDER[floor];
}
