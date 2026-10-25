# Deploying nodock on a real domain

Written for `tenorlabs.dev`. Change the two hostnames if you prefer different ones.

## Install: pull an image, do not clone the repo

```bash
curl -fsSL https://raw.githubusercontent.com/Mohammed-Mamoun98/nodock/main/scripts/install.sh | sudo bash
```

The installer creates `/opt/nodock/` holding exactly three files — `compose.yml`, `Caddyfile`,
`.env` — adds 2 GB swap if the box has none, generates `NODOCK_SECRET`, pulls the image, and
stops with a list of what still needs filling in before it will start. **The source tree is not
involved.** Contributions use `docker/compose.build.yml` to build locally instead.

`NODOCK_VERSION` in `.env` pins the image tag (`0.1.0`, not `latest`). Migrations run at boot,
so upgrades are deliberate:

```bash
sed -i 's/^NODOCK_VERSION=.*/NODOCK_VERSION=0.2.0/' /opt/nodock/.env
docker compose -f /opt/nodock/compose.yml pull && docker compose -f /opt/nodock/compose.yml up -d
```

Roll back by pinning the previous tag — the data volume is untouched by a downgrade unless the
newer release migrated the schema forward.

**Upgrading from a release that used the TCP admin API** (anything before this change): the
image, `compose.yml` and `Caddyfile` must move together, because the admin listener moved from
`:2019` to the `caddy_admin` socket. Re-run the installer (it refetches both files and keeps
your `.env`), then `docker compose up -d`. App containers stay on the unchanged `nodock`
network, so running services keep serving; only nodock leaves it, for `nodock_control`.

| Role     | Host                   | Serves                                                                                              |
| -------- | ---------------------- | --------------------------------------------------------------------------------------------------- |
| Panel    | `panel.tenorlabs.dev`  | the nodock UI + API (this is `NODOCK_URL`)                                                          |
| Services | `*.apps.tenorlabs.dev` | one host per service, e.g. `milo-api.apps.tenorlabs.dev` (this is `BASE_DOMAIN=apps.tenorlabs.dev`) |

## 1. DNS

Point both at the VPS IPv4 (`A`), and `AAAA` only if the box has working IPv6 — a broken
AAAA makes Let's Encrypt's HTTP-01 validation fail intermittently.

```
panel.tenorlabs.dev        A   <vps-ip>
*.apps.tenorlabs.dev       A   <vps-ip>
```

- **Grey cloud / DNS-only** if you use Cloudflare. The orange-cloud proxy interferes with
  ACME HTTP-01 and with long-lived SSE streams.
- If `tenorlabs.dev` has **CAA** records, they must allow `letsencrypt.org`:
  `CAA 0 issue "letsencrypt.org"`.

## 2. Certificates: on-demand per host, no wildcard cert

nodock's Caddy asks its own `/internal/caddy/ask` endpoint before issuing, so each _hostname_
gets its own certificate over HTTP-01. That needs:

- **Port 80 reachable** from the internet (HTTP-01 and the redirect to 443).
- **No wildcard certificate.** A `*.apps…` cert requires DNS-01, which needs a DNS provider
  plugin that the official `caddy:2-alpine` image does not ship. Per-host certs are fine at
  this scale; the wildcard is only needed in _DNS_, not in TLS.

Watch the ACME rate limit: **50 certificates per registered domain per week**. Create services
in batches, and while testing use the staging CA in `docker/Caddyfile`:

```
{
	acme_ca https://acme-staging-v02.api.letsencrypt.org/directory
}
```

Staging certs are untrusted by browsers — that is the point. Remove the line for production.

## 3. OAuth App

Create a **second** OAuth App rather than editing the dev one, so localhost keeps working:

| Field    | dev app                                      | prod app                                           |
| -------- | -------------------------------------------- | -------------------------------------------------- |
| Name     | `nodock-dev`                                 | `nodock`                                           |
| Homepage | `http://localhost:3000`                      | `https://panel.tenorlabs.dev`                      |
| Callback | `http://localhost:3000/auth/github/callback` | `https://panel.tenorlabs.dev/auth/github/callback` |

An OAuth App has exactly **one** callback URL, which is why two apps is the cheap solution.
Do **not** enable "expiring user tokens" — see `docs/research/github-caddy-facts.md` §1.

## 4. `.env` on the server

```ini
NODOCK_SECRET=<openssl rand -hex 32>     # never reuse the dev secret
GITHUB_CLIENT_ID=<prod app client id>
GITHUB_CLIENT_SECRET=<prod app client secret>
ADMIN_GITHUB_LOGIN=Mohammed-Mamoun98
NODOCK_URL=https://panel.tenorlabs.dev
BASE_DOMAIN=apps.tenorlabs.dev
ACME_EMAIL=<a real inbox>
DATA_DIR=/data
```

- `NODOCK_URL` must be the **exact** public https origin: it builds the OAuth redirect_uri and is
  the origin the CSRF guard trusts. A trailing slash or `http://` will cost you an afternoon.
- HTTPS flips the session cookie to `Secure` automatically (derived from `NODOCK_URL`).
- Leave `ALLOWED_ORIGINS` unset in production. It exists for the Vite dev server.

## 5. Preflight: `nodock doctor`

Before pointing a real repository at the install, run the checks that the first deploy
depends on:

```bash
docker compose -f /opt/nodock/compose.yml exec nodock bun scripts/doctor.ts
```

It verifies, in the order things actually break: GitHub OAuth credentials, the admin
allowlist, `NODOCK_URL`, the Caddy admin endpoint (the unix socket, or a warning when it is
TCP), the health probe path, the GHCR token (warning only), database writes to `/data`, the
Docker daemon, the shared `nodock` network, Caddy's admin API, the certificate gate (`/ask`
must allow the panel host), and DNS for both the panel host and the `*.BASE_DOMAIN`
wildcard. DNS problems are warnings, not blockers — records take time to propagate.

The same report is available at `GET /api/doctor` (HTTP 503 when a check fails).

## 6. Boot order

1. `./scripts/install.sh` (writes `.env`, 2 GB swap), or write `.env` by hand.
2. `docker compose -f docker/compose.yml up -d` — Caddy first, then nodock re-renders and
   `POST /load`s the full route config from the DB.
3. `curl -s https://panel.tenorlabs.dev/healthz` → `{"ok":true,"database":"ok"}`.
4. Open the panel, sign in, confirm the boot log reported
   `github oauth: configured` and a non-empty allowlist.

## 7. Verification checklist

- [ ] `https://panel.tenorlabs.dev` has a trusted cert (no warnings, no staging CA)
- [ ] `http://panel.tenorlabs.dev` redirects to https
- [ ] Sign-in completes and the session survives a browser restart (30-day cookie)
- [ ] A service host gets a cert on first request, not before (on-demand)
- [ ] `docker stats` idle: nodock ≤80 MB, Caddy ≤50 MB
- [ ] Ports 3000 and 2019 are **not** reachable from outside (`ss -lntp` on the host); since
      the admin API moved to a unix socket, nothing should be listening on 2019 at all
- [ ] `/var/lib/docker` growth is bounded (image + log pruning active)
