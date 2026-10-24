# First install on a VPS, from a clone

Use this until a release image exists on GHCR. Afterwards, `scripts/install.sh` is the shorter path
(it pulls the image and never clones).

Assumptions: Ubuntu 22.04/24.04 or Debian 12, 2 GB RAM, root or sudo, domain `tenorlabs.dev`.

## 0. Prerequisites

**Do not install Docker from snap.** The snap build is confined and can only read `$HOME`,
`/mnt` and `/media`; a project under `/opt` is mapped to `/var/lib/snapd/void/...` and compose
fails with `compose file ".../docker/compose.yml" is invalid: no such file or directory`. If
`which docker` prints `/snap/bin/docker`, remove it first:

```bash
sudo snap remove docker
```

Then install the real engine:

```bash
curl -fsSL https://get.docker.com | sh
which docker            # must be /usr/bin/docker
docker compose version

# Swap, so a memory spike does not OOM-kill the panel
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab

# Firewall: only 22, 80, 443. Never 3000 or 2019.
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw --force enable
```

## 1. DNS first, before anything else

```
panel.tenorlabs.dev       A   <vps-ip>
*.apps.tenorlabs.dev      A   <vps-ip>
```

Certificates are issued on first request and DNS must already resolve, or Caddy's challenge
fails. Verify from the VPS itself:

```bash
dig +short panel.tenorlabs.dev
dig +short test.apps.tenorlabs.dev     # must return the same IP
```

If either is empty, stop and fix DNS. If `tenorlabs.dev` has CAA records, they must include
`letsencrypt.org`.

## 2. Clone

```bash
git clone https://github.com/Mohammed-Mamoun98/nodock.git /opt/nodock-src
cd /opt/nodock-src
git log --oneline -1
```

## 3. GitHub OAuth App (prod)

github.com/settings/developers → **OAuth Apps** → New OAuth App:

| Field                      | Value                                              |
| -------------------------- | -------------------------------------------------- |
| Application name           | `nodock`                                           |
| Homepage URL               | `https://panel.tenorlabs.dev`                      |
| Authorization callback URL | `https://panel.tenorlabs.dev/auth/github/callback` |

Keep the dev app on localhost — an OAuth App has exactly one callback URL.
**Do not** enable expiring user tokens.

## 4. `.env` at the repo root

```bash
cd /opt/nodock-src
cp .env.example .env
chmod 600 .env
echo "NODOCK_SECRET=$(openssl rand -hex 32)"
```

Edit `.env` so it contains exactly:

```ini
NODOCK_SECRET=<paste the generated 64 hex chars>
GITHUB_CLIENT_ID=<prod app client id>
GITHUB_CLIENT_SECRET=<prod app client secret>
ADMIN_GITHUB_LOGIN=Mohammed-Mamoun98
NODOCK_URL=https://panel.tenorlabs.dev
BASE_DOMAIN=apps.tenorlabs.dev
ACME_EMAIL=you@yourdomain.com
```

Leave `ALLOWED_ORIGINS` unset (it exists for the Vite dev server), and leave `GHCR_USER`/`GHCR_TOKEN`
blank unless your images are private. `compose.yml` reads this file via `env_file: ../.env`,
which is why it must live at the repo root.

## 5. Build and start

```bash
cd /opt/nodock-src
docker compose -f docker/compose.yml -f docker/compose.build.yml up -d --build
docker compose -f docker/compose.yml ps
```

`compose.build.yml` builds the image locally instead of pulling `ghcr.io/...`.
`compose.yml` already sets `CADDY_ADMIN_URL=http://caddy:2019` and mounts the docker socket.

## 6. Verify before touching the browser

```bash
# boot log: expect "github oauth: configured", a non-empty allowlist, and "caddy config applied"
docker compose -f docker/compose.yml logs nodock | tail -20

# the panel over HTTPS (cert is issued on this first request)
curl -sS https://panel.tenorlabs.dev/healthz

# preflight
docker compose -f docker/compose.yml exec nodock \
  bun scripts/doctor.ts
```

`doctor` should be all `ok`. A `warn` on DNS while propagation settles is fine; a `FAIL` is not —
each one prints the hint for what to fix.

## 7. First deploy

1. Open `https://panel.tenorlabs.dev` → **Continue with GitHub** → authorise.
2. Create a project, then **New service** → pick a repo that has a `Dockerfile` → branch →
   port → **Create service**.
3. Service → **Settings** → **Enable CI**. This commits `.github/workflows/nodock.yml`, creates
   the `NODOCK_CI_TOKEN` Actions secret and registers the push webhook — all with your token.
4. Click **Deploy**. The deployment row should advance
   `queued → pulling → starting → health check → switching → live`.
5. `https://<service>.apps.tenorlabs.dev` should serve, with a certificate issued on first visit.

## Updating

```bash
cd /opt/nodock-src
git pull
docker compose -f docker/compose.yml -f docker/compose.build.yml up -d --build
```

Migrations run at boot. There is no self-update yet; keep the checkout on a tag once releases exist.

## Troubleshooting

| Symptom                                          | Cause                                                                                                                    |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `network nodock ... not found` in doctor         | the stack is not up, or you ran `docker run` outside compose                                                             |
| `curl: (7) Failed to connect`                    | Caddy container not running, or port 80/443 blocked                                                                      |
| cert warning in browser                          | the request happened before DNS propagated; re-hit after propagation                                                     |
| `redirect_uri_mismatch` from GitHub              | callback URL in the OAuth App does not exactly match `<NODOCK_URL>/auth/github/callback`                                 |
| sign-in lands on "Not authorised"                | the printed login is not in `ADMIN_GITHUB_LOGIN`                                                                         |
| `github_token_rejected` in the UI                | token revoked → sign out and back in                                                                                     |
| deploy stuck at `queued`                         | Actions never called back: check the run in the repo's Actions tab, and that `NODOCK_URL` is reachable from the internet |
| `pull 401`                                       | private GHCR package without `GHCR_TOKEN`                                                                                |
| UI shows a red `fetch` error but the panel loads | `NODOCK_URL` origin mismatch — it must be the exact public https origin                                                  |
