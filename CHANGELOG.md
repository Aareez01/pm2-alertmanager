# Changelog

## [0.2.0] - 2026-11-04

### Added

- **A native Discord channel** (`type: discord`). The generic webhook was previously the
  recommended route to Discord, and that advice was wrong on two counts. Discord answers
  an oversized embed with a 400, which is not retryable, so a long stack trace lost the
  alert outright instead of truncating it; every value is now clamped to Discord's
  documented cap before it goes out. And Discord resolves `@everyone` in anything it is
  handed, so a single log line could page an entire server at 3am over someone else's
  output - mentions are now disabled on every message this module sends.

  Severity maps to the embed colour, fields become inline embed fields, and the log
  excerpt is fenced with any fence inside it broken up so it cannot close ours early.
  `username` is optional and overrides the webhook's configured name.

### Security

- **`zod` upgraded to 4.6.7, and every array schema given an explicit `.max()`.** Below
  4.6.6, zod accumulates one issue object per failing array element with no cap
  (GHSA-mrhx-c7xc-m3w5, high). 0.1.0 shipped `zod ^3.23.8` and is affected.

  The advisory's own remediation is not sufficient here. Its description blames arrays
  *without* a length constraint; its title says *constrained* collections. Only the title
  is right - the 4.6.6 fix is an early exit taken when a length check fails, so it does
  nothing for an unconstrained array. Measured against this module's real config parser:

  | schema | zod 3.25.76 | zod 4.6.7 |
  | --- | --- | --- |
  | `z.array(...)` uncapped | 300k issues, 97 MB | 300k issues, 137 MB |
  | `z.array(...).max(10)` | 300k issues, 84 MB | 1 issue, 0 MB |

  Upgrading alone would have left parsing marginally worse while turning `npm audit`
  green, which is the worst of the available outcomes. Both halves were applied. Two
  million bad elements now cost one issue and under 50 ms.

  It was not reachable in this module: every zod call site parses the operator's own
  config file, and anyone who can write that file has better options than an allocation.
  This is hardening, and it clears the advisory for anyone auditing their dependencies.

### Removed

- **Support for Node 18 and 20** (breaking). Both are past end of life, and the test
  runner no longer executes on them, so the previous `>=18` was a claim that could not be
  verified. Supported range is now `>=22`, tested on 22, 24 and 26 by running the suite
  rather than asserting it.

### Changed

- `vitest` upgraded to 5.x, which closes a critical prototype-pollution advisory in its
  `tinypool` dependency (GHSA-5gmw-xhrv-c9v3). Development only; it never shipped.

## [0.1.0] - 2026-11-03

First release.
