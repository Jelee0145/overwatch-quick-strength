# Agent update log

## 2026-10-17 Tencent standalone website

- Goal: optimize shared query/cache/analysis path; deploy full website and authenticated Bot API to 106.55.47.68.
- confirmed-current: main at e60d53f; existing uncommitted AstrBot/chart changes are user work and must be preserved. Cloud build and 83 baseline tests passed before this task.
- confirmed-current: target Debian 13, Node 24.21, Docker with existing AstrBot/NapCat; SSH root works. No existing OWQS directory or HTTP proxy found.
- Planned files: server/*, deploy/*, test/standalone.test.mjs, scripts/package-server.mjs, src/security.mjs, src/dashen.mjs, src/services/matches.mjs, package.json, deployment docs.
- Approach: reuse Worker HTTP/auth/task contracts with a Node HTTP adapter and SQLite KV/alarms; native atomic JSON blob storage avoids chunk/delete/write overhead; memoize provider identities inside one query; enforce aggregate upstream pacing; package only explicit public/source allowlist.
- Hazards: preserve existing server workloads; never copy .private/.dev.vars/local/.private; no Cloudflare push/deploy; independent signing/pepper/key encryption secrets; Secure cookies require HTTPS; domain, credentials and account migration preference pending. Back up before replacing an existing release; no automatic cloud data migration.
- Verification: build, full existing suite and runtime checks, Cloudflare dry-run, SQLite transactions/restart/isolation, standalone HTTP/auth/Bot query/archive lifecycle, remote health and startup recovery. Real upstream acceptance requires configured credentials.
- verified: build, 94 tests, all three native workerd runtime checks and Cloudflare dry-run passed. The pending plugin test clock advanced one second per call and exhausted query budgets without dispatch; reduced only its injected clock step to 10ms. Existing plugin work remains unstaged.
- confirmed-current: Nginx installed; trusted public-IP certificate issued. Application upload, data migration, service startup and public acceptance pending.
