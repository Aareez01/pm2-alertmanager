# pm2-alertmanager — Requirements

**Status:** Draft · **Date:** 2026-10-30 · **Repo:** `pm2-alertmanager` (standalone) · **Licence:** MIT

Depends on the shared platform constraints and wire contract, which live in the
**`pm2-ops-contract`** repository (`00-platform-and-contract.md`) because both this module
and `pm2-probe` are bound by them. Read that first.

---

## 1. Problem

PM2's own notifications (email, Slack, webhook) are behind the paid PM2 Plus service. The free
alternatives — `pm2-slack`, `pm2-restart-notifier`, `pm2-webhook-monitor`, `pm2-alert` — are
single-channel, single-author packages, several unmaintained, and none handle the thing that actually
matters on-call: **noise**. An app in a crash loop emits an event per restart, and a naive notifier
turns that into fifty Slack messages at 03:00.

The differentiator here is not "sends to Slack". It is deduplication, grouping, crash-loop collapse,
and resolution notices.

## 2. Goals / Non-goals

**Goals**
- Free, self-hosted replacement for PM2 Plus notifications.
- Correct, quiet behaviour under crash-loop and flapping conditions.
- Consume both native PM2 events and `pm2-probe:status` events.

**Non-goals (v1)**
- On-call scheduling, escalation policies, acknowledgement workflows — that is PagerDuty/Opsgenie's
  job; we route *to* them.
- Metrics, dashboards, log shipping.
- Alerting on anything other than PM2-managed processes.

## 3. Functional requirements

### 3.1 Event sources

- **REQ-AM-01** — Subscribe via `pm2.launchBus()` to `process:event` and to `pm2-probe:status`.
- **REQ-AM-02** — Per F4 the native vocabulary is `start`, `online`, `exit`, `restart`, and
  `restart overlimit`. Match `'restart overlimit'` **with the space** — this is the most likely
  implementation bug in the whole module and must have a dedicated test.
- **REQ-AM-02a** — Per F4a, **`exit` fires twice per restart** (`status=stopping`, then
  `status=stopped`). All counting logic MUST deduplicate — count only `status === 'stopped'`, or
  dedupe on `(pm_id, status)`. Counting raw `exit` events trips crash-loop detection at half the
  configured threshold. Dedicated test required.
- **REQ-AM-02b** — Per F4a, the `status` field is the status **at emit time** (the `online` event
  carries `status=launching`). MUST NOT be treated as settled state; read settled state from
  `pm2.list()`.
- **REQ-AM-03** — Derive higher-level conditions rather than expecting native events:
  - **crash** = `exit` with `status === 'stopped'`, non-zero `exit_code`, and no operator action
  - **restart** = native `restart` event, or `exit` followed by `start`/`online` for the same `pm_id`
    within 30 s
  - **crash loop** = `restart overlimit`, or ≥N *deduplicated* exits for one `pm_id` within a window
- **REQ-AM-03a** — ⚠️ **`manually` MUST NOT be used to detect operator action.** Per F4b it means
  "via the API/CLI", not "by a human": a `pm2.restart()` call from `pm2-probe` produces
  `manually=true`. Suppressing on this flag would silently swallow exactly the events that matter
  most. Operator-initiated stops must instead be inferred from `exit` with `status === 'stopped'` and
  **no** corresponding `start`/`online` within the restart window — a genuine stop leaves the process
  down. Dedicated test: a probe-initiated restart MUST still alert.
- **REQ-AM-04** — Per F5, the payload is `pm2_env` minus `env`. Any enrichment needing env vars
  requires a separate `pm2.list()` call. Do not assume `env` is present.
- **REQ-AM-05** — Memory-restart alerts: per F6 there is no distinguishable signal. **Out of scope for
  v1**, documented as a known gap. (Open question Q2.)
- **REQ-AM-06** — Per C5, operate fully on native events alone when `pm2-probe` is not installed.
- **REQ-AM-07** — Per C1, ignore `pm2-probe:status` events with an unrecognised `v`, logging once per
  unknown version.

### 3.2 Noise control — the core of the module

- **REQ-AM-08** — **Deduplication.** An identical alert (same app, same `pm_id`, same condition) within
  a dedup window (default 5 min) is suppressed, with a counter incremented on the pending alert.
- **REQ-AM-09** — **Grouping window.** Events arriving within a group window (default 30 s) are
  collected into one notification rather than sent individually. A 4-instance simultaneous crash is
  one message naming 4 instances.
- **REQ-AM-10** — **Crash-loop collapse.** On `restart overlimit`, or on N crashes within a window,
  emit **one** alert describing the loop (count, window, first/last timestamp) and then suppress
  further alerts for that app until it recovers or a long re-notify interval elapses (default 1 h).

  *Revised during implementation.* This originally demanded "exactly one" alert in total. The honest
  behaviour is **two**: the first crash is reported immediately as a `warning`, and the escalation to
  a crash loop is reported once as `critical`. Satisfying the literal "exactly one" would mean holding
  the first crash for a full crash-loop window (default 60 s) before saying anything — delaying the
  notification that matters most in order to win a word count.

  The property that actually matters is that the alert count is **bounded and independent of the
  crash count**. That is what is asserted: 50, 200 and 1000 crashes each produce exactly two
  notifications.
- **REQ-AM-11** — **Flap damping.** An app transitioning healthy↔unhealthy more than N times in a
  window is alerted once as "flapping", not once per transition.
- **REQ-AM-12** — **Startup suppression.** For `startupGraceSeconds` (default 60) after module boot,
  collect but do not send. A PM2 daemon restart otherwise produces a `start`+`online` storm for every
  app. This is essential and easy to forget.
- **REQ-AM-13** — **Quiet hours.** Per-severity, with timezone. Alerts during quiet hours for
  below-threshold severities are held and summarised at the end of the window, not dropped.
- **REQ-AM-14** — **Resolution notices.** When a previously-alerted app returns to healthy and stays
  so for `resolveAfterSeconds` (default 120), send a "resolved" message. Where the channel supports
  it (Slack), update the original message thread rather than posting a new one.

### 3.3 Routing and channels

- **REQ-AM-15** — Severity levels: `info`, `warning`, `critical`. Default mapping — manual stop =
  `info` (suppressed by default), single crash = `warning`, crash loop / probe-trip = `critical`.
- **REQ-AM-16** — Routing rules match on app name (glob), namespace, severity, and condition, and
  select one or more channels. First-match-wins with an explicit default route.
- **REQ-AM-17** — v1 channels: **Slack** (incoming webhook) and **generic webhook** (POST JSON,
  user-supplied template). Per Q4, others follow demand. Designed behind a channel interface so
  Teams/Telegram/PagerDuty/Opsgenie/SMTP are additive.
- **REQ-AM-18** — Per-channel delivery retry with exponential backoff (3 attempts), and a dead-letter
  log. A failed Slack post must never crash the module (NFR-2) and must never block the event loop.
- **REQ-AM-19** — Rate-limit per channel (default 20 messages/min) with overflow collapsed into a
  single "N further alerts suppressed" message.

### 3.4 Alert content

- **REQ-AM-20** — Include: app name, `pm_id`, instance count affected, host, condition, severity,
  `restart_time`, `unstable_restarts`, exit code, uptime at failure, and `versioning.revision` where
  present.
- **REQ-AM-21** — Include the last N lines of stderr (default 15, configurable, capped at 100). Read
  from `pm_err_log_path` in the payload — **not** by buffering all `log:err` bus traffic, which would
  cost memory proportional to total log volume (NFR-1).
- **REQ-AM-22** — **Redaction.** Apply configurable regex redaction to log excerpts before sending,
  with sensible defaults for common secret shapes. Alerts leave the host; this is a security
  requirement, not a nicety.
- **REQ-AM-23** — Cap total message size per channel (Slack ~40 KB) and truncate the log excerpt
  first, never the structured fields.

### 3.5 Reliability

- **REQ-AM-24** — Per F8 the bus is fire-and-forget. Poll `pm2.list()` every 30 s and reconcile:
  if an app is `errored`/`stopped` and no alert is active for it, raise one. This catches events
  missed while the module was restarting — including the restart caused by its own `pm2 set` (F3).
- **REQ-AM-25** — Persist alert state (active alerts, dedup counters, suppression windows) to disk,
  atomically, so a module restart does not re-alert everything or lose resolution tracking.
- **REQ-AM-26** — On boot, reconcile persisted state against live `pm2.list()` before sending
  anything, then apply REQ-AM-12 startup suppression.
- **REQ-AM-27** — Bounded queues everywhere. Under sustained event flood, drop oldest and record the
  drop count rather than growing unbounded.

### 3.6 Configuration

- **REQ-AM-28** — Primary channel is module config (`pm2 set pm2-alertmanager:<key>`), with a sidecar
  YAML/JSON file for routing rules, which are too structured for flat keys. Same precedence and
  file-watch semantics as REQ-PR-26/27.
- **REQ-AM-29** — Webhook URLs are secrets. Support `${ENV_VAR}` interpolation so they need not sit in
  `module_conf.json`, and redact them from all log output and from `pm2 conf`-style display.
- **REQ-AM-30** — Boot-time schema validation per NFR-8, naming the offending path.
- **REQ-AM-31** — `pm2 trigger pm2-alertmanager test-alert` sends a synthetic alert through every
  configured route, for verifying setup without breaking something on purpose.

### 3.7 Operability

- **REQ-AM-32** — Expose via `pmx.probe()`: events received, alerts sent, alerts suppressed (by
  reason), delivery failures, active alert count, queue depth.
- **REQ-AM-33** — Structured JSON logs; every suppression decision logged at `debug` with its reason,
  so "why didn't I get paged?" is answerable.
- **REQ-AM-34** — Ignore events originating from PM2 modules themselves by default
  (`pm2_env.pmx_module === true`), including its own.

## 4. Acceptance criteria

1. An app crash-looping 50 times in 2 minutes produces **two** alerts — one `crash`, one
   `crash-loop` escalation — and the same two at 200 and 1000 crashes (REQ-AM-10). Never 50.
2. Restarting the PM2 daemon with 10 apps running produces **zero** alerts (REQ-AM-12).
3. `pm2 stop api` produces no alert at default settings; `pm2 stop api` with `alertOnManual: true`
   produces one `info` alert.
4. A `restart overlimit` event is matched — explicit test for the space in the event name.
4a. A single restart producing two `exit` events increments the crash counter by **one**, not two
    (REQ-AM-02a).
4b. A restart issued programmatically by `pm2-probe` (which arrives with `manually=true`) **does**
    produce an alert (REQ-AM-03a).
5. Killing the module mid-incident and restarting it does not re-alert the active incident, and still
   sends the resolution notice when the app recovers (REQ-AM-25/26).
6. An app that fails while the module is stopped is alerted within 30 s of the module restarting,
   via reconciliation (REQ-AM-24), not via the bus.
7. A log excerpt containing an AWS key shape is redacted before transmission (REQ-AM-22).
8. Slack webhook returning 500 three times results in a dead-letter log entry and no module crash.
9. Module runs with `pm2-probe` absent and alerts correctly on native events only (REQ-AM-06).

## 5. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Alert storm pages the whole team at 03:00 | Users uninstall immediately; reputational | REQ-AM-08/09/10/11/12/19 — noise control is the product |
| Missed alert due to fire-and-forget bus (F8) | Silent failure; worst possible outcome for an alerting tool | REQ-AM-24 reconciliation loop |
| Secrets leaked into Slack via log excerpt | Security incident | REQ-AM-22 redaction, on by default |
| Webhook URL sits in plaintext `module_conf.json` | Credential exposure | REQ-AM-29 env interpolation |
| Buffering all `log:err` to get stderr context | Unbounded memory | REQ-AM-21 read from log file on demand |

## 6. Sequencing note

Build `pm2-probe` first. `pm2-alertmanager` is independently useful on native events (REQ-AM-06), but
the demo that sells the suite — a hung process detected, restarted, and alerted — needs both, and the
probe is the half that cannot be faked.
