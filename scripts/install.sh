#!/usr/bin/env bash
# nodock installer: creates a self-contained directory holding compose.yml,
# Caddyfile and .env, then starts the stack. The user never clones this repo.
#
#   curl -fsSL https://raw.githubusercontent.com/Mohammed-Mamoun98/nodock/main/scripts/install.sh | sudo bash
#
# Override with env vars: NODOCK_DIR, NODOCK_REPO, NODOCK_REF, NODOCK_VERSION.
set -euo pipefail

NODOCK_DIR="${NODOCK_DIR:-/opt/nodock}"
NODOCK_REPO="${NODOCK_REPO:-Mohammed-Mamoun98/nodock}"
NODOCK_REF="${NODOCK_REF:-main}"
RAW="https://raw.githubusercontent.com/${NODOCK_REPO}/${NODOCK_REF}"

say() { printf '\n%s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "run as root (sudo) — it writes ${NODOCK_DIR} and swap"

command -v docker >/dev/null 2>&1 || fail "docker is not installed. Install Docker Engine first."
docker compose version >/dev/null 2>&1 || fail "the docker compose plugin is missing."

if [ ! -f /swapfile ] && [ "$(swapon --show 2>/dev/null | wc -l)" -eq 0 ]; then
  say "Adding 2 GB swap (the box is small; builds are off-host but pulls are not free)"
  fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

mkdir -p "${NODOCK_DIR}"
cd "${NODOCK_DIR}"

say "Fetching compose.yml, Caddyfile and .env.example (${NODOCK_REF})"
curl -fsSL "${RAW}/docker/compose.release.yml" -o compose.yml
curl -fsSL "${RAW}/docker/Caddyfile" -o Caddyfile

if [ -f .env ]; then
  say "Keeping the existing .env"
else
  curl -fsSL "${RAW}/.env.example" -o .env.example
  secret="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  sed "s|^NODOCK_SECRET=.*|NODOCK_SECRET=${secret}|" .env.example > .env
  chmod 600 .env
  say "Wrote .env with a generated NODOCK_SECRET"
fi

if ! grep -q '^NODOCK_VERSION=' .env; then
  echo 'NODOCK_VERSION=latest' >> .env
fi

say "Pulling ghcr.io/${NODOCK_REPO}:\$(grep '^NODOCK_VERSION=' .env | cut -d= -f2)"
docker compose pull

missing=()
grep -q '^GITHUB_CLIENT_ID=.\+' .env || missing+=("GITHUB_CLIENT_ID")
grep -q '^GITHUB_CLIENT_SECRET=.\+' .env || missing+=("GITHUB_CLIENT_SECRET")
grep -q '^ADMIN_GITHUB_LOGIN=.\+' .env || missing+=("ADMIN_GITHUB_LOGIN")
grep -q '^NODOCK_URL=https://' .env || missing+=("NODOCK_URL (must be https)")

if [ ${#missing[@]} -gt 0 ]; then
  say "Not starting yet — fill these in ${NODOCK_DIR}/.env first:"
  printf '  - %s\n' "${missing[@]}"
  cat <<EOF

You also need a GitHub OAuth App with the callback
  <NODOCK_URL>/auth/github/callback
and DNS: an A record for the panel host plus *.BASE_DOMAIN for services.

Then:
  cd ${NODOCK_DIR} && docker compose up -d
EOF
  exit 0
fi

say "Starting"
docker compose up -d
say "Done. Watch the boot log for 'github oauth: configured':"
printf '  docker compose -f %s/compose.yml logs -f nodock\n' "${NODOCK_DIR}"
