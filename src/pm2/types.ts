/** The shape of what `pm2.list()` actually returns, as far as we rely on it. */

export interface Pm2Env {
  status?: string;
  pm_id?: number;
  name?: string;
  namespace?: string;
  exec_mode?: string;
  instances?: number;
  pm_uptime?: number;
  restart_time?: number;
  unstable_restarts?: number;
  exit_code?: number;
  pmx_module?: boolean;
  pm_err_log_path?: string;
  versioning?: { revision?: string } | null;

  /** Env vars appear here directly... */
  PORT?: string | number;
  /** ...and/or nested here. Which one is populated depends on how the app was started,
   *  so both must be checked (verified live: both were set). */
  env?: Record<string, string | number | undefined>;

  [key: string]: unknown;
}

export interface Pm2Process {
  pid?: number;
  name?: string;
  pm_id?: number;
  pm2_env: Pm2Env;
  monit?: { memory?: number; cpu?: number };
}

/** Resolve an instance's listening port, checking both locations (REQ-PR-30a). */
export function resolvePort(p: Pm2Process): number | null {
  const e = p.pm2_env ?? {};
  const direct = e.PORT;
  const nested = e.env?.PORT;
  const raw = direct ?? nested;
  if (raw === undefined || raw === null || raw === '') return null;
  const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function isModule(p: Pm2Process): boolean {
  return p.pm2_env?.pmx_module === true;
}

export function isCluster(p: Pm2Process): boolean {
  return (p.pm2_env?.exec_mode ?? '').startsWith('cluster');
}
