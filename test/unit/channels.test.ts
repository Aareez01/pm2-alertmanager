import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { alertFrom, Alert } from '../../src/core/alert';
import { RenderedAlert } from '../../src/channels/types';
import { SlackChannel } from '../../src/channels/slack';
import { WebhookChannel } from '../../src/channels/webhook';
import { TeamsChannel } from '../../src/channels/teams';
import { TelegramChannel } from '../../src/channels/telegram';
import { PagerDutyChannel } from '../../src/channels/pagerduty';
import { OpsgenieChannel } from '../../src/channels/opsgenie';

/** Captures what each channel actually puts on the wire. */
interface Captured { path: string; headers: http.IncomingHttpHeaders; body: any }
let server: http.Server;
let base: string;
let last: Captured | null = null;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      last = { path: req.url ?? '', headers: req.headers, body: b ? JSON.parse(b) : null };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const alert: Alert = alertFrom({
  kind: 'crash', severity: 'critical', app: 'api', pmId: 3,
  at: Date.now(), detail: { exitCode: 1 },
}, 'web-01');

const rendered = (resolved = false): RenderedAlert => ({
  title: 'api crashed (instance 3)',
  text: 'api crashed\napp: api\nhost: web-01',
  fields: { app: 'api', host: 'web-01', severity: 'critical', exitCode: 1 },
  logExcerpt: ['Error: boom', '  at main()'],
  resolved,
});

describe('Slack', () => {
  it('posts blocks with a severity colour and the log excerpt', async () => {
    await new SlackChannel('s', `${base}/hook`).send(alert, rendered());
    expect(last!.body.text).toBe('api crashed (instance 3)');
    const att = last!.body.attachments[0];
    expect(att.color).toBe('#dc2626');
    expect(JSON.stringify(att.blocks)).toContain('Error: boom');
  });

  it('switches to green when resolved', async () => {
    await new SlackChannel('s', `${base}/hook`).send(alert, rendered(true));
    expect(last!.body.attachments[0].color).toBe('#16a34a');
  });
});

describe('generic webhook', () => {
  it('sends a structured default payload', async () => {
    await new WebhookChannel('w', `${base}/hook`).send(alert, rendered());
    expect(last!.body).toMatchObject({
      app: 'api', condition: 'crash', severity: 'critical',
      pm_ids: [3], host: 'web-01', resolved: false,
    });
  });

  it('applies custom headers', async () => {
    await new WebhookChannel('w', `${base}/hook`, { 'x-token': 'abc' }).send(alert, rendered());
    expect(last!.headers['x-token']).toBe('abc');
  });

  it('renders a user template into valid JSON', async () => {
    const tpl = '{"msg":"{{title}}","sev":"{{severity}}","app":"{{app}}"}';
    await new WebhookChannel('w', `${base}/hook`, {}, tpl).send(alert, rendered());
    expect(last!.body).toEqual({ msg: 'api crashed (instance 3)', sev: 'critical', app: 'api' });
  });

  it('escapes template values so quotes cannot break the JSON', async () => {
    const tpl = '{"msg":"{{title}}"}';
    const r = { ...rendered(), title: 'he said "boom" \\ then' };
    await new WebhookChannel('w', `${base}/hook`, {}, tpl).send(alert, r);
    expect(last!.body.msg).toBe('he said "boom" \\ then');
  });
});

describe('Teams', () => {
  it('posts a MessageCard with facts', async () => {
    await new TeamsChannel('t', `${base}/hook`).send(alert, rendered());
    expect(last!.body['@type']).toBe('MessageCard');
    expect(last!.body.themeColor).toBe('DC2626');
    const names = last!.body.sections[0].facts.map((f: any) => f.name);
    expect(names).toContain('app');
  });

  it('escapes HTML in the log excerpt', async () => {
    const r = { ...rendered(), logExcerpt: ['<script>alert(1)</script>'] };
    await new TeamsChannel('t', `${base}/hook`).send(alert, r);
    expect(JSON.stringify(last!.body)).toContain('&lt;script&gt;');
  });
});

describe('Telegram', () => {
  it('sends HTML to the bot sendMessage endpoint', async () => {
    await new TelegramChannel('tg', 'TOKEN123', '-100999', base).send(alert, rendered());
    expect(last!.path).toBe('/botTOKEN123/sendMessage');
    expect(last!.body.chat_id).toBe('-100999');
    expect(last!.body.parse_mode).toBe('HTML');
  });

  it('escapes HTML so a stack trace cannot break formatting', async () => {
    const r = { ...rendered(), logExcerpt: ['Error: <tag> & more'] };
    await new TelegramChannel('tg', 'T', '1', base).send(alert, r);
    expect(last!.body.text).toContain('&lt;tag&gt; &amp; more');
  });
});

describe('PagerDuty', () => {
  it('triggers with the fingerprint as dedup_key', async () => {
    await new PagerDutyChannel('pd', 'RKEY', base).send(alert, rendered());
    expect(last!.path).toBe('/v2/enqueue');
    expect(last!.body.event_action).toBe('trigger');
    expect(last!.body.dedup_key).toBe(alert.fingerprint);
    expect(last!.body.payload.severity).toBe('critical');
  });

  it('resolves the SAME incident rather than opening a new one', async () => {
    await new PagerDutyChannel('pd', 'RKEY', base).send(alert, rendered(true));
    expect(last!.body.event_action).toBe('resolve');
    expect(last!.body.dedup_key).toBe(alert.fingerprint);
    expect(last!.body.payload).toBeUndefined();
  });
});

describe('Opsgenie', () => {
  it('creates an alert with the fingerprint as alias and a GenieKey header', async () => {
    await new OpsgenieChannel('og', 'APIKEY', base).send(alert, rendered());
    expect(last!.path).toBe('/v2/alerts');
    expect(last!.headers.authorization).toBe('GenieKey APIKEY');
    expect(last!.body.alias).toBe(alert.fingerprint);
    expect(last!.body.priority).toBe('P1');
  });

  it('closes by alias when resolved', async () => {
    await new OpsgenieChannel('og', 'APIKEY', base).send(alert, rendered(true));
    expect(last!.path).toContain('/close?identifierType=alias');
    expect(last!.path).toContain(encodeURIComponent(alert.fingerprint));
  });
});
