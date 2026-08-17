# Dependency-security audit

Last checked: 2026-08-17 with `npm audit --omit=dev --audit-level=high`.

The command currently reports 20 advisories: 12 high, 7 moderate, and 1 low.
The install host did not complete a compatible `npm audit fix` within the two-minute command limit; no dependency files were changed by that attempted remediation.

Remaining high-severity groups are tracked explicitly until a compatibility-tested upgrade can be made:

- Solana chain: `@solana/web3.js` / `@solana/spl-token` pull in `bigint-buffer`, `uuid`, and an older nested `ws`. The available automatic remediation requests a breaking Solana package change. Do not use `--force` on a trading engine; validate transaction construction and signing in paper mode first.
- ORM chain: `drizzle-orm` is below the advisory-fixed release. The advertised remediation is breaking; schedule the upgrade with schema/query integration tests before deployment.
- HTTP/build chain: `body-parser`, `qs`, `path-to-regexp`, `postcss`, `picomatch`, `brace-expansion`, `lodash`, `nanoid`, `minimatch`, `yaml`, and `ws` have compatible updates advertised. Retry the non-forced lockfile update from a networked CI runner and require `npm test` plus the paper health check before merging.

Mitigations already in this repository: request JSON is bounded by Express configuration, secrets and Solana identifiers are redacted from application logs, the container runs as non-root, and production starts in paper mode by default. This document is an exception register, not acceptance of the risks.
