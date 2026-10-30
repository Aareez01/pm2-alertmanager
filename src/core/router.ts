import { Alert, atLeast } from './alert';
import { Severity, ConditionKind } from './detector';

export interface RouteMatch {
  /** Glob on app name: "api", "api-*", "*". */
  app?: string;
  namespace?: string;
  /** Minimum severity this route accepts. */
  severity?: Severity;
  condition?: ConditionKind[];
}

export interface Route {
  match: RouteMatch;
  channels: string[];
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

export function matches(route: Route, alert: Alert): boolean {
  const m = route.match;
  if (m.app && !globToRegExp(m.app).test(alert.app)) return false;
  if (m.namespace && m.namespace !== (alert.namespace ?? 'default')) return false;
  if (m.severity && !atLeast(alert.severity, m.severity)) return false;
  if (m.condition && m.condition.length > 0 && !m.condition.includes(alert.kind)) return false;
  return true;
}

/**
 * First match wins. A route with an empty `match` matches everything and acts as the
 * default, so put it last.
 */
export function route(routes: Route[], alert: Alert): string[] {
  for (const r of routes) {
    if (matches(r, alert)) return r.channels;
  }
  return [];
}
