import { Alert } from '../core/alert';
import { RenderedAlert } from '../channels/types';
import { tailLines } from './logtail';
import { redact, RedactionRule } from './redact';

const KIND_TITLES: Record<string, string> = {
  crash: 'crashed',
  'crash-loop': 'is crash-looping',
  'operator-stop': 'was stopped',
  restart: 'restarted',
  'probe-fail': 'failed its health probe',
  recovered: 'recovered',
};

export interface RenderOptions {
  logLines: number;
  rules: RedactionRule[];
  /** Hard cap on the rendered message, excluding channel envelope. */
  maxBytes: number;
}

export async function render(
  alert: Alert,
  opts: RenderOptions,
  resolved = false,
): Promise<RenderedAlert> {
  const what = KIND_TITLES[alert.kind] ?? alert.kind;
  const instances = alert.pmIds.length === 1
    ? `instance ${alert.pmIds[0]}`
    : `${alert.pmIds.length} instances (${alert.pmIds.join(', ')})`;

  const title = resolved
    ? `RESOLVED: ${alert.app} — ${what}`
    : `${alert.app} ${what} (${instances})`;

  const d = alert.detail;
  const fields: RenderedAlert['fields'] = {
    app: alert.app,
    instances: alert.pmIds.join(', '),
    host: alert.host,
    severity: alert.severity,
    condition: alert.kind,
    namespace: alert.namespace,
    occurrences: alert.count > 1 ? alert.count : undefined,
    exitCode: d.exitCode as number | undefined,
    restarts: d.restartTime as number | undefined,
    unstableRestarts: d.unstableRestarts as number | undefined,
    revision: (d.revision as string) ?? undefined,
    reason: d.reason as string | undefined,
    probe: d.probe as string | undefined,
    probeAction: d.action as string | undefined,
  };

  let excerpt: string[] = [];
  if (!resolved && typeof d.errLogPath === 'string' && opts.logLines > 0) {
    const raw = await tailLines(d.errLogPath, opts.logLines);
    excerpt = raw.map((l) => redact(l, opts.rules));
  }

  const lines = [title, ''];
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== '') lines.push(`${k}: ${v}`);
  }

  let text = lines.join('\n');
  if (excerpt.length > 0) {
    // Truncate the log excerpt first; the structured fields are never sacrificed.
    let body = `${text}\n\nstderr (last ${excerpt.length}):\n${excerpt.join('\n')}`;
    while (Buffer.byteLength(body, 'utf8') > opts.maxBytes && excerpt.length > 0) {
      excerpt.shift();
      body = `${text}\n\nstderr (last ${excerpt.length}, truncated):\n${excerpt.join('\n')}`;
    }
    text = body;
  }

  return { title, text, fields, logExcerpt: excerpt, resolved };
}
