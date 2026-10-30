# pm2-alertmanager

Self-hosted alerting for PM2 - crash, crash-loop and health-probe alerts to Slack or any
webhook, **with the noise control on-call actually needs**.

PM2's own notifications are behind the paid PM2 Plus service. The free alternatives are
single-channel scripts that forward every event verbatim, which means an app crash-looping
fifty times wakes you fifty times. This module exists for everything that happens between
"a process died" and "a human should be told".

```bash
pm2 install pm2-alertmanager
pm2 set pm2-alertmanager:channels '{"oncall":{"type":"slack","webhookUrl":"${SLACK_WEBHOOK_URL}"}}'
pm2 set pm2-alertmanager:routes   '[{"match":{},"channels":["oncall"]}]'
pm2 trigger pm2-alertmanager test-alert
```

Works standalone. If [`pm2-liveness`](../pm2-liveness) is also installed, health-probe failures
become alerts too.

---

## What it actually does

Sending a Slack message is the easy part. These are the parts that matter:

| Behaviour | Why |
| --- | --- |
| **Crash-loop collapse** | 50 crashes produce 2 notifications (one crash, one escalation), not 50 - and the count stays at 2 for 1000 crashes |
| **Startup suppression** | A PM2 daemon restart emits `start`+`online` for every app at once. Without a grace window, every restart pages the whole team - including the restart `pm2 set` triggers on this module itself |
| **Deduplication** | The same problem on the same instance inside 5 minutes is one alert with a counter |
| **Grouping** | Four instances failing together is one message naming four instances |
| **Flap damping** | An app bouncing healthy↔unhealthy is alerted once as flapping |
| **Resolution notices** | When it recovers and stays recovered, you get told |
| **Reconciliation** | The PM2 bus is fire-and-forget, so anything that happened while this module was down was missed entirely. It also polls `pm2.list()` |

Every suppression decision is logged at `debug` with its reason, so **"why didn't I get
paged?"** is always answerable.

---

## Three things PM2 does that break naive alerting

These cost real debugging to find, and any PM2 alerting tool has to handle them.

### 1. `exit` fires twice per restart

One restart emits `exit`(status=`stopping`), `exit`(status=`stopped`), `online`, `restart`.
Counting raw `exit` events trips crash-loop detection at **half** the configured threshold.
This module counts only `status === 'stopped'`.

### 2. `manually: true` does not mean a human did it

It means **"PM2 was asked to act"**, via the API or CLI - a `pm2.restart()` from `pm2-liveness`
sets it too. Treating it as "a human did it" would silently swallow exactly the automated
restarts worth paging about.

It is also **always `false` on an exit event**, so it cannot classify one. What
distinguishes a deliberate stop from a crash is what happens *next*:

| After the exit | Treated as |
| --- | --- |
| a `restart` event follows | **restart** - something asked PM2 to act |
| it comes back, non-zero exit code | **crash** |
| it comes back, clean exit code | **restart** |
| it stays down, autorestart **on** | **operator stop** - silent |
| it stays down, autorestart **off** | **crash** |

The invariant: a process that died on its own always alerts. A restart triggered by
`pm2-liveness` is reported once, as `probe-fail`, not twice.

### 3. There is no "crashed" event

PM2's entire vocabulary is `start`, `online`, `exit`, `restart` and `restart overlimit`
(with a space - not a colon or underscore). Everything else is derived.

Memory-triggered restarts emit **nothing on the bus**: `max_memory_restart` calls
`reloadProcessId` directly. The only trace anywhere is a line in PM2's own daemon log, so
this module tails it:

```yaml
memoryRestarts:
  enabled: true        # opt-in
  pollSeconds: 5
```

Best-effort by nature - it is tied to a log string rather than an API, so a PM2 release
could change it. The failure mode is silence, never a wrong alert.

---

## Configuration

Module config for simple setups, a sidecar file for real routing:

```bash
pm2 set pm2-alertmanager:configFile /etc/pm2-alertmanager/config.yaml
```

```yaml
logLevel: info
startupGraceSeconds: 60
resolveAfterSeconds: 120

suppression:
  groupWindowSeconds: 30
  dedupWindowSeconds: 300
  crashLoopRenotifySeconds: 3600
  minSeverity: warning
  quietHours:
    enabled: true
    startHour: 22
    endHour: 7
    timezone: Europe/London
    alwaysSend: critical      # critical pages regardless

content:
  logLines: 15                # stderr excerpt, read from the log file on demand
  redactions:                 # added to the built-in rules, never replacing them
    - name: internal-ids
      pattern: 'cust_[A-Za-z0-9]{10}'

channels:                                # seven types available
  oncall:
    type: slack
    webhookUrl: ${SLACK_WEBHOOK_URL}     # resolved from the environment
  ops:
    type: webhook
    url: ${OPS_WEBHOOK}
    headers: { X-Source: pm2 }
  pager:
    type: pagerduty
    routingKey: ${PD_ROUTING_KEY}        # resolution CLOSES the incident
  # also: teams, telegram, opsgenie, smtp

routes:                                  # first match wins
  - match: { app: 'api-*', severity: critical }
    channels: [oncall, ops]
  - match: {}                            # default - put it last
    channels: [ops]
```

A route naming a channel that doesn't exist is **rejected at boot**, because the
alternative is finding out at 3am.

### Secrets

Webhook URLs are credentials. Any string may reference an environment variable as
`${NAME}`, so they need not sit in `module_conf.json`, and they are masked in all log
output.

### Why not `ecosystem.config.js`?

PM2 silently discards unknown keys from app definitions - its validator is a whitelist, so
a config block there vanishes with no warning. Use `pm2 set` or the sidecar file.

---

## Channels

| Type | Required config | Notes |
| --- | --- | --- |
| `slack` | `webhookUrl` | blocks, colour-coded by severity |
| `webhook` | `url` | JSON; optional `template` with `{{app}}`, `{{title}}`, … |
| `teams` | `webhookUrl` | MessageCard |
| `telegram` | `botToken`, `chatId` | HTML; `baseUrl` for a self-hosted Bot API |
| `pagerduty` | `routingKey` | Events API v2; `baseUrl` for EU accounts |
| `opsgenie` | `apiKey` | Alerts API v2; `baseUrl` for EU |
| `smtp` | `host`, `from`, `to` | requires `npm install nodemailer` |

PagerDuty and Opsgenie are more than formatting: the alert fingerprint becomes the
`dedup_key` / alias, so repeats group into one incident and a resolution notice **closes
that incident** instead of opening a new one.

`nodemailer` is an optional dependency - nobody should download an SMTP stack to post to
Slack. If the `smtp` channel is used without it, the error says exactly what to install.

## Severity and routing

| Condition | Default severity |
| --- | --- |
| `operator-stop`, `restart` | `info` (below the default floor, so not sent) |
| `crash`, `memory-restart` | `warning` |
| `crash-loop`, `probe-fail` | `critical` |

Routes match on app glob, namespace, minimum severity and condition. Severity is a
**floor**, not an equality test: `severity: warning` also matches `critical`.

---

## Alert content and redaction

Alerts carry the last 15 lines of stderr, read from the file PM2 already wrote rather than
by buffering the log bus - buffering would cost memory proportional to total log volume
across every app on the host, for data needed only when something breaks.

**Redaction is on by default**, because these excerpts leave your host and land in a chat
history that is searchable and exportable. Built-in rules cover AWS keys, bearer tokens,
JWTs, URL credentials, `password=`-style assignments, private key blocks and Slack webhook
URLs. Custom rules are added to the built-ins, never replace them, and an invalid custom
regex is ignored rather than disabling the defaults.

---

## Reliability

The PM2 bus has no delivery guarantee and no replay - a subscriber that is down misses
events permanently. Two things follow:

- **Reconciliation.** Every 30 s the module compares `pm2.list()` against its own active
  alerts and raises anything it missed.
- **Persisted state.** Alert state is written atomically, so a restart mid-incident does
  not re-alert everything or lose resolution tracking. This matters more than it sounds:
  `pm2 set` restarts this module, so it happens during routine config changes.

Delivery retries three times with exponential backoff; a permanent failure is written to
the log as a dead letter rather than vanishing. Per-channel rate limiting caps output at 20
messages/minute with the overflow reported as a count.

---

## Troubleshooting

**No alerts at all** - check `minSeverity` (default `warning` means `info` conditions are
dropped), confirm a route matches, and run `pm2 trigger pm2-alertmanager test-alert`.

**Alerts stopped mid-incident** - expected. Crash-loop collapse suppresses follow-ups for
an hour, or until the app recovers.

**`pm2` commands hang forever** - your `PM2_HOME` path is too long. PM2 binds
`$PM2_HOME/rpc.sock` and Linux caps socket paths at 107 characters; over that the bind
fails silently and every client blocks. Check with
`echo -n "$PM2_HOME/rpc.sock" | wc -c`.

---

## Requirements

Node 18 or newer - tested on 18, 20, 22, 24 and 26 - with PM2 5 or newer.

## Development

```bash
npm install && npm run build && npm test
```

## Design documentation

- [`docs/requirements.md`](./docs/requirements.md) - requirements this was built against,
  including one revised after implementation disagreed with it.
- Platform findings and the `pm2-liveness:status` contract live in **`pm2-ops-contract`**.

## License

MIT
