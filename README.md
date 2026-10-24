# nodock

A lightweight self-hosted PaaS with a Railway-like UX, built for one 2 GB / 1 vCPU VPS.

Two containers, no Postgres, no Redis. Builds happen in **GitHub Actions**, not on the
server: nodock pulls the resulting image from GHCR, runs it, routes to it, and reports status.

> Status: **M1 (scaffold) complete** — workspace, Hono server, SQLite + Drizzle schema and
> migrations, config loader, `/healthz`, `/metrics-lite`, web shell, Docker/compose packaging.
> Auth, CI, deploys, and routing land in later milestones. See the plan.

## Layout

```
apps/server   Bun + Hono, SQLite via bun:sqlite + Drizzle, Docker/GitHub behind adapters
apps/web      React + Vite + Tailwind (Radix allowed for Dialog/Tabs only)
docker        Dockerfile, compose (prod + dev), Caddy bootstrap config
docs          measurements, research notes
```

## Dev quickstart

```bash
bun install
cp .env.example .env          # set NODOCK_SECRET (openssl rand -hex 32), NODOCK_URL, BASE_DOMAIN

bun run dev:server            # http://localhost:3000  (bun --smol --watch)
bun run dev:web               # http://localhost:5173  (Vite proxies /api /auth /webhooks)
```

```bash
bun test                      # no Docker, no GitHub, no network
bun run typecheck
bun run build:web             # then the server serves apps/web/dist
```

## Docs

- `i-wanna-build-sth-compiled-clock.md` — the v1 plan (scope, architecture, budgets, milestones)
- `docs/measurements.md` — resource budgets vs measured numbers
- `docs/research/` — external facts that were verified, with sources

## Security note

nodock mounts `/var/run/docker.sock`, which is root-equivalent on the host, and Caddy's admin
API is unauthenticated. Keep the panel OAuth-gated + allowlisted, never publish port 3000,
and split the Docker networks so app containers cannot reach the admin API.
