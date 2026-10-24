# Measurements

Budgets live in the plan (`i-wanna-build-sth-compiled-clock.md` → *Resource budgets*).
Every row records where it was taken, because a laptop number is not a VPS number.

## M1 — scaffold (2026-10-24, macOS arm64, Bun 1.4.2)

Single process, `bun --smol apps/server/src/index.ts`, empty migrated DB, zero services, no Docker calls.

| Metric | Budget | Measured | Verdict |
|---|---|---|---|
| nodock idle RSS | ≤80 MB | **27 MB** (`/metrics-lite`, confirmed by `ps` 28.4 MB) | pass |
| heap used | — | 4 MB | — |
| nodock + Caddy | ≤120 MB | not measured (no Caddy in dev) | pending |
| `GET /healthz` | — | 200, `{ok:true,database:"ok"}` | — |
| `GET /metrics-lite` | — | 200 | — |
| initial JS (web) | ≤120 KB gz | **69.2 KB gz** (`vite build`, 16 modules) | pass |
| CSS (web) | — | 2.4 KB gz | — |

Notes:
- `--smol` was on for this run. Re-measure without it before claiming the delta.
- The web build is the bare shell (no Radix yet); **69 KB is the floor, not the final number**.
  Re-measure when Dialog + Tabs land, and again at M7 completion.
- 1-hour idle CPU and 10-service-row load are still outstanding (they need the seed data from M3).

## M1 — verification

- `bun test` → 13 pass / 0 fail (config, health, schema, cascade, host uniqueness).
- `tsc -p apps/server`, `tsc -p apps/web` → clean.
- Boot smoke: migrations applied from `apps/server/drizzle`, `/healthz` 200, `/metrics-lite` 200,
  SPA `index.html` served at `/`, unmounted `/api/*` → 501 typed error (not an HTML fallback).
