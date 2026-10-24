# nodock

A lightweight self-hosted PaaS with a Railway-like UX, built for one 2 GB / 1 vCPU VPS.

Two containers, no Postgres, no Redis. Builds happen in **GitHub Actions**, not on the
server: nodock pulls the resulting image from GHCR, runs it, routes to it, and reports status.

> Status: **M1 complete** (workspace, Hono server, SQLite schema/migrations, config, `/healthz`, CI-less packaging)
> plus the **dashboard UI ported from the Superdesign canvas** — dashboard grid, service detail,
> new-service wizard, variables editor, all on mock fixtures. Auth, CI, and real deploys are next.

Routes (hash router, no routing dependency): `#/`, `#/services/new`, `#/services/:id`,
`#/services/:id/variables`.

## Layout

```
apps/server   Bun + Hono, SQLite via bun:sqlite + Drizzle, Docker/GitHub behind adapters
apps/web      React + Vite + Tailwind (Radix allowed for Dialog/Tabs only)
docker        Dockerfile, compose (prod + dev), Caddy bootstrap config
docs          measurements, research notes
```

## Install

On a VPS with Docker (no repo clone, no build on the box):

```bash
curl -fsSL https://raw.githubusercontent.com/Mohammed-Mamoun98/nodock/main/scripts/install.sh | sudo bash
```

See `docs/DEPLOY.md` for DNS, the OAuth App, certificates, and the upgrade path.

## Dev quickstart

```bash
bun install
cp .env.example .env          # set NODOCK_SECRET (openssl rand -hex 32); blank optional vars are fine

bun run dev:server            # http://localhost:3000  (run from the repo root: that is where .env lives)
bun run dev:web               # http://localhost:5173  (Vite proxies /api /auth /webhooks)
```

```bash
bun test                      # no Docker, no GitHub, no network
bun run typecheck
bun run lint                  # oxlint
bun run fmt                   # oxfmt (prettier-compatible)
bun run verify                # fmt:check + lint + typecheck + tests + render smoke
bun run build:web             # then the server serves apps/web/dist
```

`bun install` enables the committed git hook (`core.hooksPath = .githooks`). The pre-commit
hook formats and lints only staged files, re-stages what oxfmt rewrote, and blocks the commit
on a lint error. `git commit --no-verify` skips it; run `bun run verify` before pushing.

`.env` lives in the **repo root** and Bun only loads it from the process working directory.
The root scripts run from the root for that reason; if you invoke the server directly, use
`bun --env-file=.env apps/server/src/index.ts`. Boot prints whether GitHub OAuth, the admin
allowlist, and the GHCR token are configured, so a silent config miss is visible immediately.

## Docs

- `i-wanna-build-sth-compiled-clock.md` — the v1 plan (scope, architecture, budgets, milestones)
- `.superdesign/design-system.md` — the design contract (tokens, states, component conventions)
- `docs/measurements.md` — resource budgets vs measured numbers
- `docs/DEPLOY.md` — real-domain wiring: DNS, ACME, OAuth App, `.env`, checklist
- `docs/research/` — external facts that were verified, with sources

## Auth

GitHub **OAuth App**, single-admin, allowlisted by login. nodock asks for `repo workflow`
(`workflow` is required to commit `.github/workflows/*`; see `docs/research/github-caddy-facts.md`).

| Piece        | How                                                                                                                                 |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Login        | `GET /auth/github` → GitHub → `GET /auth/github/callback`                                                                           |
| State        | HMAC-signed nonce + timestamp, 10-minute window, no server-side store                                                               |
| Session      | 32 random bytes, SHA-256 hash stored, HttpOnly + Secure + SameSite=Lax, 30 days                                                     |
| GitHub token | AES-256-GCM with a key derived from `NODOCK_SECRET` — losing that secret loses the token and every variable                         |
| Guard        | `/api/*` returns 401 JSON when signed out; SPA shows the login gate                                                                 |
| CSRF         | Mutating `/api/*` requests must carry a same-origin `Origin` header; `ALLOWED_ORIGINS` adds extras (the Vite dev server on `:5173`) |
| Reconnect    | If the user grants less than `repo workflow`, `/api/me` reports `needsReconnect` and the top bar links back through the OAuth flow  |

Endpoints: `GET /api/me`, `POST /api/auth/logout` (plus the two `/auth/github*` routes).

**Local dev:** `NODOCK_URL` must be the origin the OAuth callback lands on, so use
`http://localhost:3000` and register `http://localhost:3000/auth/github/callback` in the OAuth
App. Browse the panel at `:3000` (served build) or `:5173` (Vite) - cookies are per-host, so
the session works on both ports, but `:5173` must be in `ALLOWED_ORIGINS` for mutations.

## Security note

nodock mounts `/var/run/docker.sock`, which is root-equivalent on the host, and Caddy's admin
API is unauthenticated. Keep the panel OAuth-gated + allowlisted, never publish port 3000,
and split the Docker networks so app containers cannot reach the admin API.

## License

MIT — see [LICENSE](LICENSE).
