# nodock

A lightweight, self-hosted PaaS with a Railway-like UX, built for one 2 GB / 1 vCPU VPS.

Two containers — nodock and Caddy — no Postgres, no Redis. Builds run in **GitHub Actions**,
not on the server: nodock pulls the resulting image from GHCR, runs it, routes to it, and
reports what the container is actually doing. A repo without a Dockerfile still deploys: the
build picks a recipe for what the repo is, and a site that builds to files never becomes a
container at all.

## What works today

- **Sign in with GitHub.** Single admin, allowlisted by login. Sessions are hashed, server-side
  tokens — no JWT machinery.
- **Projects → environments → services.** Create a project, add a service from one of your
  repos, pick a branch. nodock reads the repo first (`EXPOSE`, Dockerfile and context paths,
  framework) so the form is prefilled rather than guessed.
- **No Dockerfile required.** Four strategies, chosen by what the repository is:
  `dockerfile` (unchanged, and it always wins if you add one), `next` (nodock's own recipe:
  standalone ~220 MB, or a `next start` image with an amber advisory), `static` (Vite, Astro,
  CRA, `next export` — files uploaded to nodock and served by Caddy, zero containers), and
  `railpack` (everything else: Go, Python, PHP, Ruby, Nuxt, SvelteKit). The build reports what
  it actually produced and how big it is; a guess made at create time never decides a deploy.
- **Build-time variables, by rule.** Names starting with `NEXT_PUBLIC_`, `VITE_`, `REACT_APP_`,
  `EXPO_PUBLIC_`, `NUXT_PUBLIC_` or `PUBLIC_` are sent to the build over the CI callback channel
  and tagged `build` in the panel. No per-row toggle: forgetting one is the bug the rule removes.
- **CI wired into the repo.** Enable CI commits `.github/workflows/nodock.yml`, stores a
  scoped callback secret as an Actions secret, and registers the push webhook. The panel says
  whether that workflow is current, edited, or deleted — and never overwrites your edits.
- **Deploy on push or by hand.** Push → webhook → `repository_dispatch` → Actions builds and
  pushes `ghcr.io/<owner>/<repo>:<slug>-<sha>` → nodock pulls, runs with limits, health-checks
  through Caddy's private probe listener, then switches the route.
- **Two logs, two places.** The deploy log (pull, start, health, switch) is kept on disk and
  streamed in the panel. The app's own stdout/stderr streams from `docker logs -f`.
- **Rollback.** Pick a previous successful deployment and nodock runs its exact image digest
  again — same pull → run → health → switch path, no rebuild, no GitHub. It uses today's
  variables, so this is code rollback, not config rollback.
- **Variables per environment**, encrypted at rest with AES-256-GCM under `NODOCK_SECRET`.
  The repo's `.env.example` (or `.env.sample` / `.env.template`) is read for the names it
  asks for, and the panel offers the ones you have not set — names only, since a
  placeholder value in a template is not a secret and not a default.
- **An HTTPS URL per environment** under `BASE_DOMAIN`, with automatic certificates. A custom
  domain column is modelled and served by Caddy; the panel has no editor for it yet.
- **Install and upgrade from an image**, with the panel auto-deployed from `main` by CI
  (`scripts/self-update.sh` restores the previous image if the new one fails `/healthz`).
- **A doctor** (`bun run doctor`, `GET /api/doctor`) that checks the daemon, networks, Caddy
  admin socket, certificate gate, DNS, and config in the order they actually bite.

## Status you can trust

A deployment record and the container's current state are **separate facts**. A deploy that
worked stays recorded as such; what Docker says about the container is checked every 15 seconds
and written next to it. So a crash loop can no longer look green:

| Deployment | Container (from `docker inspect`)     | The panel says                                      |
| ---------- | ------------------------------------- | --------------------------------------------------- |
| `live`     | `running`                             | **active**                                          |
| `live`     | `restarting`                          | **crash loop** (amber) with restart count           |
| `live`     | `exited` / `dead` / `missing`         | **crashed** (red) with the daemon's reason and code |
| `live`     | daemon unreachable                    | **unknown** — never invented as an outage           |
| any        | replaced by a newer successful deploy | **superseded**                                      |

The API ships the same sentence the UI shows (`container killed by the OOM killer, exit 137`,
`container is gone — nothing is running for this deployment`), so every view tells one story.

**Not in the panel yet:** start/stop/restart, persistent volumes, multi-replica services,
CPU/RAM graphs, PR previews, teams, multi-server, monorepo Next (`outputFileTracingRoot`). Also not covered: an app that is _running but
broken_ (500s, wrong port) still looks healthy — that needs each service's health path polled
continuously.

## Backups — not implemented, decision recorded

`DATA_DIR/backups` exists in the config and nothing writes to it. Nothing on the box protects
you from losing the box.

What is at risk is small and precise. Images live in GHCR, code lives in GitHub, and
`scripts/install.sh` rebuilds a host in about ten minutes. The irreplaceable state is the SQLite
database plus `NODOCK_SECRET` in `.env`: services, releases, and the encrypted variables. So
losing `/data` costs configuration, not code — but losing `NODOCK_SECRET` makes the variables in
any restored database unreadable. A backup that skips the key is a backup of nothing.

Planned shape, smallest first:

1. **Droplet backups.** Weekly, whole disk, enabled at install. The only layer that covers total
   loss including `.env`. `doctor` cannot see the provider account, so it can only remind.
2. **Nightly snapshot to object storage.** `VACUUM INTO` a scratch file, tar it with `.env`,
   encrypt, upload to S3-compatible storage, retain by count. Restores onto a fresh droplet in
   minutes instead of a rebuild, with a day of RPO.
3. **Credentials.** S3 keys in nodock's own encrypted variables — the same AES-256-GCM path as
   everything else — with `NODOCK_SECRET` and the S3 keys kept in 1Password. Letting nodock read
   1Password directly would put the `op` binary and a service-account token inside the container:
   a new dependency and a long-lived credential, in exchange for storing two values that are
   already encrypted at rest. Not worth it.
4. **A rehearsed restore.** `docs/RESTORE.md`, run once against a throwaway droplet. An untested
   backup is a wish.

Until then, by hand, on the box that has the data:

```bash
cd /opt/nodock
sudo docker compose stop nodock                  # a consistent SQLite copy, not a WAL mid-write
sudo docker compose cp nodock:/data ./nodock-$(date +%F)
sudo docker compose start nodock
sudo cp .env ./nodock-$(date +%F)/.env           # the key lives outside /data, so copy it too
scp -r ./nodock-$(date +%F) you@elsewhere:       # anything off the box counts
rm -rf ./nodock-$(date +%F)
```

And put `NODOCK_SECRET` in 1Password the day you install. It is generated once, printed nowhere,
and is the only way back into the variables.

## Layout

```
apps/server   Bun + Hono, SQLite via bun:sqlite + Drizzle, Docker/GitHub/Caddy behind adapters
apps/web      React (Preact alias) + Vite + Tailwind, hash router, no routing dependency
docker        Dockerfile, compose (prod, dev, release), Caddy bootstrap config
docs          setup, deploy, CI, measurements, verified external facts
scripts       installer, self-update, doctor, web render smoke
```

Routes (hash router): `#/`, `#/services/new`, `#/services/:id`, `#/settings`,
`#/services/:id/variables`; the active project travels as `?project=<id>`.

## Install

On a VPS with Docker (no repo clone, no build on the box):

```bash
curl -fsSL https://raw.githubusercontent.com/Mohammed-Mamoun98/nodock/main/scripts/install.sh | sudo bash
```

The installer writes `/opt/nodock/` (`compose.yml`, `Caddyfile`, `.env`), adds swap if the box
has none, generates `NODOCK_SECRET`, and stops with the values still missing. See
`docs/DEPLOY.md` for DNS, the OAuth App, certificates, and upgrading; `docs/VPS-SETUP.md` for
the step-by-step first install.

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
hook scans staged changes for secrets, then formats and lints only those files, re-staging what
oxfmt rewrote, and blocks the commit on a leak or a lint error. `git commit --no-verify` skips
it; run `bun run verify` before pushing.

The secret scan is [gitleaks](https://github.com/gitleaks/gitleaks) driving `scripts/check-secrets.sh`
(`brew install gitleaks`). It is deliberately optional: with no binary on `PATH` the scan prints a
skip notice and lets the commit through, because the Docker build runs the same lifecycle scripts
where gitleaks does not exist. `bun run check:secrets` sweeps the whole tree by hand.
Because the check lives only in the hook, `--no-verify` is a real hole — nothing else repeats it.

`.env` lives in the **repo root** and Bun only loads it from the process working directory.
The root scripts run from the root for that reason; if you invoke the server directly, use
`bun --env-file=.env apps/server/src/index.ts`. Boot prints whether GitHub OAuth, the admin
allowlist, and the GHCR token are configured, so a silent config miss is visible immediately.

## Docs

- `v0-plan.md` — the original plan: scope, architecture, budgets, milestones, rejected options
- `.superdesign/design-system.md` — the design contract (tokens, states, component conventions)
- `docs/measurements.md` — resource budgets vs measured numbers
- `docs/VPS-SETUP.md` — first install on a VPS (clone → DNS → OAuth → `.env` → build → verify)
- `docs/DEPLOY.md` — real-domain wiring: DNS, ACME, OAuth App, `.env`, checklist
- `docs/CI.md` — the push→build→run flow, what nodock writes into your repo, and every credential
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

Building works through your own repository, not an installed app: nodock commits a workflow,
creates an Actions secret, and registers a push webhook with your token. See `docs/CI.md`.

**Local dev:** `NODOCK_URL` must be the origin the OAuth callback lands on, so use
`http://localhost:3000` and register `http://localhost:3000/auth/github/callback` in the OAuth
App. Browse the panel at `:3000` (served build) or `:5173` (Vite) - cookies are per-host, so
the session works on both ports, but `:5173` must be in `ALLOWED_ORIGINS` for mutations.

## Security note

nodock mounts `/var/run/docker.sock`, which is root-equivalent on the host. Two things keep
that away from the apps you deploy:

- **Two docker networks.** `edge` (`nodock`) holds Caddy and the app containers; `control`
  (`nodock_control`) holds Caddy and nodock. nodock is not on `edge`, so a compromised app
  cannot reach the panel API. Health checks reach new containers through Caddy's private
  probe listener (`:8099`, unpublished) instead.
- **No TCP admin API.** Caddy's admin listens on a unix socket (`caddy_admin` volume) that
  only nodock mounts. There is no port to reach, even from a container on the wrong network.

Still: keep the panel OAuth-gated + allowlisted and never publish port 3000. If you set
`CADDY_ADMIN_URL` (TCP) for compatibility, remember that anything sharing a network with
Caddy can then rewrite routing — `/api/doctor` warns about it.

Back up `/data` (and `NODOCK_SECRET`) or lose every encrypted variable.

## License

MIT — see [LICENSE](LICENSE).
