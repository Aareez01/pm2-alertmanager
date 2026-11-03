# Changelog

## [0.1.0] - 2026-11-03

First release.

### Dependencies

- `zod` 4.6.7 and `vitest` 5.x. zod below 4.6.6 accumulates one issue object per failing
  array element with no cap (GHSA-mrhx-c7xc-m3w5, high); no release of this module ever
  shipped an affected version. Array schemas also carry explicit length caps, because the
  4.6.6 fix only short-circuits when a length constraint is present.
