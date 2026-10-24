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

## M1.5 — dashboard UI ported from the Superdesign canvas (2026-10-24, macOS arm64, Bun 1.4.2, Vite 8.3.5)

Drafts ported: dashboard grid (`be90196f` v4), service detail, new-service wizard, variables editor.
No icon or routing dependencies: icons are inline SVG, routing is a 40-line hash router.

| Metric | Budget | React | Preact alias | Verdict |
|---|---|---|---|---|
| initial JS (raw) | — | 253.0 KB | **47.8 KB** | 5.3× smaller |
| initial JS (gz) | ≤120 KB | 76.5 KB | **15.0 KB** | pass, 8× headroom |
| CSS (gz) | — | 4.9 KB | 4.9 KB | pass |
| control-plane RSS serving the SPA | ≤80 MB | 44 MB | 44 MB | pass |

Alias: `@preact/preset-vite` maps `react`, `react-dom`, and `react/jsx-runtime` to
`preact/compat`, so source keeps React idioms and the browser gets Preact. `StrictMode` was
dropped (no double-invoke semantics to preserve). React and react-dom are no longer runtime
dependencies; `@types/react` stays for typechecking only, which is why **types alone cannot
prove the alias works** — hence the render gate below.

## Render gate (catches what types and builds cannot)

`bun run smoke:web` builds the app, mounts the production bundle in a happy-dom window, and
asserts the rendered markup: product mark, project switcher, a service card, the failure copy
(`add GHCR_TOKEN`), the ingress node, the filter row, and the state vocabulary.

Last run: 8/8 checks, 14.7 KB of DOM from `index-DfaauvDr.js`.

Notes:
- No visual QA in this session (no browser). Layout review still needs a human on
  `bun run dev:web` or the canvas.
- Inter / JetBrains Mono are referenced with system fallbacks (no webfont request), so type
  is close to the canvas but not identical without those fonts installed.

## M1 — verification

- `bun test` → 13 pass / 0 fail (config, health, schema, cascade, host uniqueness).
- `tsc -p apps/server`, `tsc -p apps/web` → clean.
- Boot smoke: migrations applied from `apps/server/drizzle`, `/healthz` 200, `/metrics-lite` 200,
  SPA `index.html` served at `/`, unmounted `/api/*` → 501 typed error (not an HTML fallback).
