# nodock — a lightweight self-hosted PaaS with Railway-like UX

## Context

Coolify and Dokploy spend a large share of a small VPS on the control plane itself: Coolify runs Laravel + Postgres + Redis + a realtime server; Dokploy runs a Node monorepo + Postgres + Redis + Traefik. Before deploying a single app, you've paid for 4+ containers and several hundred MB to well over a gigabyte of RAM.

`nodock` is a greenfield, self-hosted PaaS for **one 2 GB / 1 vCPU VPS**, built to keep the control plane genuinely small (2 containers, no Postgres, no Redis) while giving a Railway-like experience: projects, environments, service cards, one-click deploy, instant HTTPS URLs, live logs, variables, and rollback.

Because the target box is small, **builds happen in GitHub Actions, not on the VPS**. nodock builds nothing; it pulls the resulting image from GHCR, runs it, routes to it, and reports status. That removes the biggest RAM/CPU spike from the server and keeps the control plane lean.

Repo is empty (only README) — this plan builds the project from scratch.

## Confirmed v1 scope

**In:**
- GitHub OAuth login, restricted to an allowlisted GitHub username (single admin).
- Services deploy from a **GitHub repo that has a Dockerfile**.
- CI builds: GitHub Actions builds the repo's Dockerfile and pushes to GHCR; nodock pulls and runs.
- Projects → environments → services. Multi-environment schema from day one (production first; staging addable).
- Auto-deploy on push via a GitHub webhook that dispatches the CI build.
- Every service gets an instant URL under a wildcard base domain; custom domains supported. Automatic HTTPS.
- Per-environment variables, secrets encrypted at rest.
- Build status with a link to Actions, deploy logs, deploy history, one-click rollback.
- Start / stop / restart service.
- Cards + detail-tabs dashboard.
- Install via `docker compose` (nodock + Caddy only).

**Out (explicitly):** local/VPS builds, auto-detect/buildpacks, prebuilt-image deploys without CI, Docker Compose stacks, managed databases, persistent volumes, CPU/RAM metrics, PR preview environments, cron jobs, teams/RBAC, multi-server, self-update, build args/secrets.

> Two deliberate cuts worth knowing: (1) no volumes, so stateful apps can't persist data in v1 — a small follow-up (one field + one Docker flag); (2) builds require GitHub Actions to be enabled on the repo.

## Stack

| Piece | Choice | Why |
|---|---|---|
| Runtime | **Bun** (`oven/bun:1-alpine`) | Built-in SQLite, fast startup, low idle memory |
| API | **Hono** (+ `hono/bun`, `hono/streaming`) | Tiny, SSE helper, portable to Node if needed |
| UI | **React + Vite + Tailwind + shadcn/ui** | Fast, familiar, good component quality |
| DB | **SQLite (`bun:sqlite`)** + Drizzle ORM | No extra container; WAL + `synchronous=NORMAL` |
| Container ops | **`docker` CLI via `Bun.spawn`** (socket mounted) | Only pull/run/stop/inspect needed now |
| Builds | **GitHub Actions → GHCR** | Off the VPS; free for public repos, 2,000 min/mo private |
| Proxy/TLS | **Caddy** container | Automatic HTTPS + on-demand TLS; full config via admin API |
| Queue | In-process, SQLite-backed rows | No Redis; only pulls/starts are queued (light) |
| Secrets | AES-256-GCM, key at `/data/secret.key` | Simple, no external KMS |
| Sessions | Random 32-byte token, SHA-256 hash in DB, HttpOnly+Secure+SameSite=Lax cookie | No JWT machinery |

**Portability guardrail:** keep Docker access behind a small `DockerAdapter` interface so tests use a fake and the CLI can later be swapped for the Engine API. Keep GitHub access behind a `GitHubClient` interface for the same reason.

## Architecture

```
                 GitHub
        push ──► webhook ──► nodock ──► repository_dispatch ──► Actions (build)
                                  ▲                                  │
                                  └────── started / built callbacks ─┘
                                             (GHCR push)
Internet :80/:443
      │
   ┌──▼──────────┐        admin API (:2019)
   │   caddy     │◄──────────────┐
   └──┬───────┬──┘               │
      │       │  panel.<base>    │
      │       └──────────────► ┌─┴──────────┐
      │                        │  nodock    │  Bun + Hono + SQLite
      │   app routes           │  /data     │  mounts docker.sock
      ▼                        └─────┬──────┘
  app containers  ◄──────────────────┘  docker pull / run / logs
  (no published ports, restart: unless-stopped)
```

- Caddy is the **only** ingress. App containers publish no host ports; Caddy reaches them by container name on the shared `nodock` network.
- nodock mounts `/var/run/docker.sock` (root-equivalent — document it) and `/data` (SQLite, deploy logs, key, Docker auth).
- If nodock is down, deployed apps and Caddy keep serving; on boot nodock reconciles and re-applies routes. CI builds still run, but their callbacks may be lost — see recovery.

### CI flow in detail

1. **Enable CI** (per repo, once): nodock commits a generic workflow to the repo's **default branch** via the Contents API and creates a repo Actions secret `NODOCK_CI_TOKEN` via the Actions secrets API (libsodium sealed box with `tweetnacl`). The UI shows a diff and asks for confirmation; on branch-protection failure it shows the YAML + instructions.
2. **Build trigger**:
   - **Manual**: `POST /api/services/:id/envs/:envId/deploy` creates a `queued` deployment and calls `POST /repos/{o}/{r}/dispatches` with `event_type: nodock-build`.
   - **Push**: the repo webhook (`push` event) matches services by repo and environments by branch, then creates a `queued` deployment and dispatches per matching service_env.
3. **Workflow** (generated once, repo-agnostic except for `NODOCK_URL`):
   ```yaml
   name: nodock
   on:
     repository_dispatch:
       types: [nodock-build]
   permissions: { contents: read, packages: write }
   jobs:
     build:
       runs-on: ubuntu-latest
       steps:
         - name: Notify start
           continue-on-error: true
           run: |
             curl -fsS -X POST "<NODOCK_URL>/api/ci/started" \
               -H "Authorization: Bearer ${{ secrets.NODOCK_CI_TOKEN }}" \
               -H "Content-Type: application/json" \
               -d '{"buildId":"${{ github.event.client_payload.buildId }}","repo":"${{ github.repository }}","runUrl":"${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}"}'
         - uses: actions/checkout@v4
           with: { ref: "${{ github.event.client_payload.sha }}" }
         - uses: docker/setup-buildx-action@v3
         - uses: docker/login-action@v3
           with:
             registry: ghcr.io
             username: ${{ github.actor }}
             password: ${{ secrets.GITHUB_TOKEN }}
         - uses: docker/build-push-action@v6
           with:
             context: "${{ github.event.client_payload.context }}"
             file: "${{ github.event.client_payload.dockerfile }}"
             push: true
             tags: "${{ github.event.client_payload.image }}:${{ github.event.client_payload.sha }}"
         - name: Notify built
           continue-on-error: true
           run: |
             curl -fsS -X POST "<NODOCK_URL>/api/ci/built" \
               -H "Authorization: Bearer ${{ secrets.NODOCK_CI_TOKEN }}" \
               -H "Content-Type: application/json" \
               -d '{"buildId":"${{ github.event.client_payload.buildId }}","repo":"${{ github.repository }}","runUrl":"${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}"}'
   ```
   `repository_dispatch` always uses the workflow from the **default branch**, so no per-branch files. The checkout uses the dispatched SHA, so the build is exact.
4. **Dispatch payload** (≤10 top-level props, <64 KB): `buildId`, `ref` (branch), `sha`, `image` (`ghcr.io/<owner>/<repo>/<service-slug>`, lowercased), `dockerfile`, `context`, `serviceSlug`. Repo is available as `github.repository` in the workflow.
5. **Callbacks** are authenticated with the repo-scoped token (stored hashed in `repo_hooks`); each includes `repo` and `buildId`, and nodock rejects mismatches. `started` records the exact Actions run URL; `built` enqueues the deploy.
6. **Pull** — `docker login ghcr.io` at boot when `GHCR_USER`/`GHCR_TOKEN` are set (classic PAT with `read:packages`; anonymous works for public packages), then `docker pull image:sha`. Auth failures surface a clear "add GHCR_TOKEN" error.
7. nodock then starts the container, health-checks, switches the Caddy route, and stops the old container. Build logs stay in Actions; deploy logs live in nodock.

**Why this shape:** Actions never runs for unrelated branches, nodock decides exactly which service/Dockerfile/context to build, CI returns a deterministic `buildId` correlation, and only one small workflow file is ever committed.

### Repo layout (Bun workspace)

```
nodock/
├─ apps/
│  ├─ server/                 # Bun + Hono
│  │  ├─ src/index.ts         # serve(), static SPA, route mounting
│  │  ├─ src/config.ts        # env + /data paths + secret key
│  │  ├─ src/db/              # schema.ts, client.ts, migrations/
│  │  ├─ src/auth/            # github oauth, sessions, guard
│  │  ├─ src/github/          # oauth, repos, branches, hooks, dispatch,
│  │  │                       # workflow commit, actions secrets (sealed box)
│  │  ├─ src/ci/              # workflow template, build callbacks, watchdog
│  │  ├─ src/deploy/          # queue, state machine, pull, run, health, rollback
│  │  ├─ src/docker/          # DockerAdapter (real + fake)
│  │  ├─ src/caddy/           # config generation, admin client, ask endpoint
│  │  ├─ src/routes/          # api handlers by area
│  │  └─ test/
│  └─ web/                    # React + Vite + Tailwind + shadcn
│     ├─ src/pages/           # login, projects, project, service tabs, settings
│     ├─ src/components/      # ServiceCard, StatusDot, LogViewer, EnvVarEditor, ...
│     └─ src/lib/api.ts       # typed fetch + TanStack Query hooks
├─ docker/                    # Dockerfile, compose.yml, compose.dev.yml, Caddyfile
├─ scripts/install.sh
├─ docs/
├─ package.json               # workspaces
└─ README.md
```

### Data model

```
users            id, github_id UNIQUE, login, avatar_url, token_enc, created_at
sessions         id, user_id FK, token_hash UNIQUE, expires_at, created_at
settings         key PRIMARY KEY, value
projects         id, name, slug UNIQUE, created_at
environments     id, project_id FK, name, slug, is_default, created_at
                 UNIQUE(project_id, slug)
services         id, project_id FK, name, slug UNIQUE, repo_full_name,
                 dockerfile_path (default 'Dockerfile'), context_path (default '.'),
                 container_port (nullable → read EXPOSE), created_at
service_envs     id, service_id FK, environment_id FK, branch, health_path,
                 generated_host UNIQUE, custom_domain UNIQUE, created_at
                 UNIQUE(service_id, environment_id)
variables        id, service_env_id FK, key, value_enc, created_at
                 UNIQUE(service_env_id, key)
repo_hooks       id, repo_full_name UNIQUE, hook_id, webhook_secret_enc,
                 ci_token_hash, workflow_sha, ci_enabled_at, created_at
deployments      id, service_env_id FK, status, trigger ('manual'|'push'|'rollback'),
                 commit_sha, commit_message, image_ref, container_name,
                 ci_run_url, rollback_of, error, log_path,
                 created_at, started_at, finished_at
```

Indexes: `deployments(service_env_id, created_at DESC)`, `deployments(status)`, `variables(service_env_id)`, `sessions(token_hash)`, `services(project_id)`.

A repo-level `repo_hooks` row means one webhook + one CI token + one workflow per repo; services share it. `workflow_sha` lets the UI detect a stale/edited workflow.

### Deployment pipeline

State machine (persisted on `deployments`):

```
queued ──► pulling ──► starting ──► healthchecking ──► switching ──► live
   │           └──────────┴──────────────┴──────────────┴──────────► failed
   └──────────────────────────────────────────────────────────────► cancelled
```

1. **queued** — deployment created; dispatch sent (manual/push) or, for rollback, skipped straight to `pulling`.
2. **pulling** — `docker pull <image_ref>`; streamed into `/data/logs/<deploymentId>.log`.
3. **starting** — `docker run -d --name nodock-<slug>-<env>-<id> --network nodock --restart unless-stopped --label nodock.* --log-opt max-size=10m --log-opt max-file=3`, env vars injected from DB. No `-p`.
4. **healthchecking** — if `health_path` set, poll `http://<container>:<port><path>` from the platform for up to 60s; otherwise require running + 3s grace.
5. **switching** — add/replace the Caddy route for the host to the new container, then `docker stop` + `docker rm` the previous container. The old image is kept for rollback.
6. **live** — URL shown in the UI.

Failure: remove the new container, leave the old route/container untouched, keep the log file, mark `failed` with the Actions link when CI failed. Cancellation allowed while `queued`/`pulling`.

Concurrency: one pull/start at a time per service_env, at most 2 globally; build concurrency is entirely GitHub's concern. A newer build for the same service env supersedes queued/older work: mark the older one `cancelled (superseded)`.

**Rollback** = new deployment that runs the chosen historical `image_ref` with the **current** env vars (code rollback, not config rollback), then the normal start→switch path.

**Watchdog / recovery:** on boot and every minute, mark `queued` deployments older than 30 minutes `failed (CI never reported back)`; mark in-flight `pulling..switching` rows `failed (interrupted)` and reconcile containers by `nodock.deployment` label; re-render and `POST /load` the full Caddy config from DB state. If a callback was lost while nodock was down, the previous live container is untouched; the user can redeploy the image (the image is already in GHCR).

### Caddy routing

- Bootstrap config (mounted file) only enables the admin API on `0.0.0.0:2019` and on-demand TLS with `ask: http://nodock:3000/internal/caddy/ask`.
- On every route-relevant change, the platform renders the **entire** config from the DB and `POST /load`s it (all-or-nothing; previous config restored on error). One writer, so no merge races. Debounce render calls and batch changes because `/load` aborts in-flight ACME work.
- Route order: dashboard host (`NODOCK_URL`) → each service host → fallback 404. Each app route is `reverse_proxy <container_name>:<port>`.
- `/internal/caddy/ask?domain=` returns 200 only for the dashboard host or a host present in `service_envs` (generated or custom), else 403. ACME still requires DNS to point at the server, so this cannot mint certs for arbitrary domains.
- Generated host: `<service.slug>.<BASE_DOMAIN>` for the default env, `<service.slug>-<env.slug>.<BASE_DOMAIN>` otherwise; service slugs are globally unique.
- Caddy autosaves config; nodock also re-applies on boot, so either side restarting converges.

### Auth & GitHub integration

- GitHub **OAuth App** (`repo` scope), authorize → callback → exchange code → `GET /user`; reject unless `login` is in `ADMIN_GITHUB_LOGIN` (comma-separated). Store the user token encrypted.
- The same token drives repo listing, hook creation, `repository_dispatch`, workflow commits, and Actions-secret creation (`repo` covers all of these). On 401, surface a "Reconnect GitHub" state.
- `state` in a short-lived signed cookie; verify on callback. Re-validate identity on every token receipt per GitHub guidance.
- Sessions expire in 30 days; logout deletes the row. Mutations require a same-origin `Origin` check.
- Adding the first service for a repo registers a `push` webhook (`POST /repos/{o}/{r}/hooks`, JSON, secret) and (when the user enables CI) commits the workflow + secret.
- Webhook endpoint `POST /webhooks/github` verifies `X-Hub-Signature-256` (HMAC-SHA256 with the per-repo secret) before parsing.
- On push, match services by repo, environments by branch, skip if `ci` isn't enabled, then dispatch.
- GHCR pulls use a separate **classic PAT with `read:packages`** (`GHCR_USER`/`GHCR_TOKEN` in `.env`), because Docker login to GHCR does not accept OAuth tokens. Public packages need no token.

### API surface (Hono, same origin as the SPA)

- Auth: `GET /auth/github`, `GET /auth/github/callback`, `POST /api/auth/logout`, `GET /api/me`
- GitHub: `GET /api/github/repos`, `GET /api/github/repos/:owner/:repo/branches`
- CI: `GET /api/repos/:owner/:repo/ci` (status/preview), `POST /api/repos/:owner/:repo/ci/enable`, `POST /api/ci/started`, `POST /api/ci/built`
- Projects: `GET/POST /api/projects`, `GET/PATCH/DELETE /api/projects/:id`
- Environments: `POST /api/projects/:id/environments`, `DELETE /api/environments/:id`
- Services: `POST /api/projects/:id/services`, `GET/PATCH/DELETE /api/services/:id`
- Service env config: `GET/PATCH /api/services/:id/envs/:envId`
- Variables: `GET/PUT /api/services/:id/envs/:envId/variables` (bulk replace)
- Deploy: `POST /api/services/:id/envs/:envId/deploy`, `POST .../stop|start|restart`, `GET .../deployments`, `GET /api/deployments/:id`, `POST /api/deployments/:id/rollback`, `POST /api/deployments/:id/cancel`
- Logs: `GET /api/deployments/:id/logs`, `GET /api/deployments/:id/logs/stream` (SSE), `GET /api/services/:id/envs/:envId/logs/stream` (SSE)
- Domain: `PUT /api/services/:id/envs/:envId/domain`
- Settings: `GET/PATCH /api/settings`
- Integrations: `POST /webhooks/github`, `GET /internal/caddy/ask`

### UI

- `/login` — single "Continue with GitHub" button.
- `/` — projects list + create project.
- `/projects/:id` — header with project name, environment switcher, "New service"; grid of service cards (status dot, branch@sha, last deploy, deploy/stop action); opening a card shows the service detail.
- Service detail tabs:
  - **Deployments** — history with status, commit, duration, a "Build on GitHub ↗" link per row, live deploy log, rollback.
  - **Logs** — runtime follow.
  - **Variables** — per-env key/value, secret masking, bulk save.
  - **Settings** — repo/branch, Dockerfile path, context, port, health path, generated + custom domain, CI status (`Not enabled` / `Enabled` / `Workflow out of date` / `Workflow modified`) with an **Enable CI** / **Update workflow** action, danger zone.
- `/settings` — base domain (from env in v1), GitHub connection status, GHCR pull-token status.
- State: TanStack Query polling 2–3s for project/service/deploy state; SSE only for logs. shadcn `Card`, `Tabs`, `Dialog`, `Badge`, `Input`, `Table`, `Sonner`.
- Onboarding: first project → New service wizard (repo picker → branch → Dockerfile path → port → enable CI → create & deploy). Sensible defaults so the first deploy works without touching settings.
- While a deploy is `queued` and CI hasn't reported, the card shows "Building on GitHub" with a link to the repo's Actions page; it switches to the exact run link when `started` arrives.

### Install & configuration

`docker/compose.yml`:

```yaml
services:
  caddy:
    image: caddy:2-alpine
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    networks: [nodock]
    restart: unless-stopped
  nodock:
    build: { context: .., dockerfile: docker/Dockerfile }
    env_file: ../.env
    volumes:
      - nodock_data:/data
      - /var/run/docker.sock:/var/run/docker.sock
    environment:
      DOCKER_CONFIG: /data/docker
    networks: [nodock]
    depends_on: [caddy]
    restart: unless-stopped
networks: { nodock: { name: nodock } }
volumes: { caddy_data: {}, caddy_config: {}, nodock_data: {} }
```

`.env` (written by `scripts/install.sh`, which generates `NODOCK_SECRET`):
`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `ADMIN_GITHUB_LOGIN`, `NODOCK_URL` (e.g. `https://panel.example.com`), `BASE_DOMAIN` (e.g. `apps.example.com`), `NODOCK_SECRET`, optional `GHCR_USER`/`GHCR_TOKEN`.

Install steps in the README: create the GitHub OAuth App with callback `<NODOCK_URL>/auth/github/callback`, set `panel` + `*` A records to the server, add 2 GB swap, run `install.sh`, open `NODOCK_URL`.

### Local development

- `docker/compose.dev.yml`: nodock container with source bind-mounted and `bun --watch`, Docker socket mounted, port 3000 published; Vite on the host proxies `/api`, `/auth`, `/webhooks` to `localhost:3000`.
- App containers are created on the same `nodock` network so name-based routing behaves exactly as in production; Caddy runs in dev too (HTTP or internal TLS).
- Docker Desktop must be running locally (verified: the socket is unavailable when stopped); on macOS point `DOCKER_HOST` at its socket.
- CI integration can be manually tested against a throwaway GitHub repo; the full loop is testable locally with a `GitHubClient` fake that simulates dispatch + callbacks.
- `bun test` runs entirely on fakes and needs no Docker or GitHub.

## Milestones

1. **Scaffold** — Bun workspace, Hono server, Vite/shadcn web, SQLite + Drizzle migrations, config loader, `/healthz`, dev compose.
2. **Auth** — GitHub OAuth, allowlist, sessions, SPA guard, `GET /api/me`.
3. **Model + CRUD + GitHub reads** — projects, environments, services, service_envs, variables; repo/branch pickers; encryption helpers.
4. **CI integration** — generic workflow template; commit workflow + create Actions secret (sealed box); register push webhook; dispatch on manual/push; verify callbacks; CI status in settings.
5. **Deploy core** — DockerAdapter (real + fake), pull/run/health/switch, SSE deploy logs, history. **Usable MVP after this step.**
6. **Caddy** — config renderer, admin client, generated/custom hosts, on-demand TLS ask, boot reconciliation.
7. **UI completion** — service cards, all tabs, log viewer, variable editor, rollback, CI enable/update flows, settings.
8. **Packaging** — Dockerfile, compose, `install.sh`, `.env.example`, docs, sample Dockerfile app.
9. **Hardening** — restart recovery, watchdog, image/log pruning, error surfaces, rate limits on CI/webhook/ask endpoints, tests.

**Cut if needed:** multi-env UI (keep the schema + default env; add the switcher later), custom domains (generated hosts only), restart/stop buttons.

## Testing / verification

- **Unit** (`bun test`): encryption round-trip, session hashing, webhook HMAC, CI token hashing, workflow template rendering, dispatch payload shape, image-ref normalization, slug/host generation and uniqueness, Caddy config rendering (snapshot), state-machine transitions, supersede/cancel.
- **Integration**: API tests against in-memory SQLite with **fake GitHub** (dispatch/callback capture) and **fake DockerAdapter** — manual deploy, push-triggered deploy, CI failure, stale-callback watchdog, rollback, interrupted restart.
- **Manual E2E** on the VPS (or local Docker for run/routing):
  1. `./scripts/install.sh`, configure the OAuth app, DNS (`panel`, `*.apps`), swap.
  2. Log in, create a project → service from a sample repo with a Dockerfile, enable CI (verify the workflow commit + secret), deploy, open the generated HTTPS URL.
  3. Push a commit → Actions builds → nodock deploys automatically. Edit a variable, redeploy, confirm it changed. Open logs. Roll back.
  4. Stop Docker Actions mid-build → deployment fails with a link. Stop nodock during a build → the callback is lost; watchdog marks it failed; redeploy works.
  5. Restart nodock after a deploy → app stays reachable and routes are re-applied.
- **Resource check**: `docker stats` idle for nodock + caddy; confirm the control plane stays under ~150 MB.

## Risks / gotchas

- **GHCR pull token is setup friction.** Private packages need a classic PAT with `read:packages`; public packages pull anonymously. Detect 401 on pull and link to the setting.
- **Docker socket = root.** Inherent to the product; document it, keep the dashboard OAuth-gated + allowlisted, and never expose port 3000 publicly (Caddy only).
- **Default-branch dependency.** `repository_dispatch` only runs a workflow that exists on the default branch; branch protection can block the bot commit. Fall back to showing the YAML + instructions. The checkout uses the dispatched SHA, so non-default branches still build correctly.
- **Callbacks are best-effort.** `continue-on-error` keeps the build green if nodock is unreachable; the watchdog and "redeploy last image" cover the gap.
- **CI minutes.** Every enabled-service push dispatches a build (private repos consume the monthly quota). No branch filter exists in v1; document it.
- **Actions permissions.** Workflows need `packages: write`; org policy or disabled Actions will fail — surface the run link and a clear message.
- **Dockerfile must live inside the build context** for subdirectory builds; validate this in the service form (a Dockerfile path outside `context_path` is rejected).
- **Workflow path collision.** If `.github/workflows/nodock.yml` already exists with different content, never overwrite silently — show a diff and require an explicit overwrite decision.
- **Orgs/SSO.** The pull PAT may need SSO authorization; the package may need repo access granted.
- **Caddy `/load` aborts in-flight ACME** — batch/debounce route renders.
- **Synchronous `bun:sqlite`** blocks the loop; schema is tiny and queries short — keep startup reconciliation batched and bounded.
- **Disk growth** — prune images to the last 10 per service and deploy logs to the last 50; document it.
- **Bun compatibility** — no dockerode; Docker stays behind a spawn-based adapter. Hono/React/SQLite remain portable to Node (`better-sqlite3`) if needed.
- **Build logs are not in nodock** — this is the one deliberate UX compromise; deployment rows link directly to the Actions run.

## Memory expectation (estimates, not measured)

- nodock: ~50–110 MB RSS (Bun + Hono + SQLite, no local builds); Caddy ~30–50 MB → **~80–160 MB total idle**.
- Coolify: Laravel app + Postgres + Redis + realtime ≈ **~0.7–1.5 GB** typical.
- Dokploy: Node app + Postgres + Redis + Traefik ≈ **~0.5–1.0 GB** typical.

Builds run on GitHub-hosted runners, so the VPS sees no build spike at all.
