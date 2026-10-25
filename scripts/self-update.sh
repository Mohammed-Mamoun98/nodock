#!/bin/sh
# Switch the running panel to a published image.
#
# Builds never happen here: .github/workflows/deploy.yml builds, this pulls. The
# box is 1 vCPU — running `vite build` on it to upgrade the panel would be its own
# outage. Safe to run by hand:
#
#   ./scripts/self-update.sh sha-1a2b3c4   # deploy a specific build
#   ./scripts/self-update.sh --rollback    # go back to the image that was running before
#
# On a failed health check the previous image is restored and the script exits
# non-zero, so the workflow (and you) see it.
set -eu

IMAGE_REPO="${IMAGE_REPO:-ghcr.io/mohammed-mamoun98/nodock}"
COMPOSE_FILE="${COMPOSE_FILE:-docker/compose.yml}"
STATE_DIR="${STATE_DIR:-.deploy}"
HEALTH_ATTEMPTS="${HEALTH_ATTEMPTS:-30}"

ROOT="$(cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT"

# NODOCK_IMAGE overrides the image line in compose.yml, so a rollback can point at
# any ref — including a locally built `nodock:dev`.
dc() { NODOCK_IMAGE="$1" docker compose -f "$COMPOSE_FILE" "${@:2}"; }

running_image() {
  local id
  id="$(NODOCK_IMAGE= docker compose -f "$COMPOSE_FILE" ps -q nodock 2>/dev/null | head -n1 || true)"
  [ -n "$id" ] || return 0
  docker inspect --format '{{.Config.Image}}' "$id" 2>/dev/null || true
}

wait_for_health() {
  local attempt
  for attempt in $(seq 1 "$HEALTH_ATTEMPTS"); do
    if NODOCK_IMAGE= docker compose -f "$COMPOSE_FILE" exec -T nodock \
      wget -qO- http://127.0.0.1:3000/healthz >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

# Pulls (when the ref lives in a registry) and recreates the container.
switch_to() {
  local image="$1"
  case "$image" in
    ghcr.io/*)
      if [ -n "${GHCR_USER:-}" ] && [ -n "${GHCR_TOKEN:-}" ]; then
        printf '%s' "$GHCR_TOKEN" |
          docker login ghcr.io --username "$GHCR_USER" --password-stdin >/dev/null
      fi
      NODOCK_IMAGE="$image" docker compose -f "$COMPOSE_FILE" pull nodock
      ;;
  esac
  NODOCK_IMAGE="$image" docker compose -f "$COMPOSE_FILE" up -d nodock
  wait_for_health
}

target=""
if [ "${1:-}" = "--rollback" ]; then
  target="$(cat "$STATE_DIR/previous-image" 2>/dev/null || true)"
  if [ -z "$target" ]; then
    echo "nothing to roll back to: $STATE_DIR/previous-image is empty" >&2
    exit 1
  fi
elif [ -n "${1:-}" ]; then
  case "$1" in
    *:*) target="$1" ;;           # a full image ref
    *) target="$IMAGE_REPO:$1" ;; # a bare tag
  esac
else
  echo "usage: $0 <tag> | --rollback" >&2
  exit 1
fi

mkdir -p "$STATE_DIR"
current="$(running_image)"
echo "panel: ${current:-<not running>} -> $target"

if switch_to "$target"; then
  printf '%s\n' "$current" >"$STATE_DIR/previous-image"
  printf '%s\n' "$target" >"$STATE_DIR/current-image"
  echo "panel is on $target"
  exit 0
fi

echo "health check failed for $target" >&2
if [ -z "$current" ] || [ "$current" = "$target" ]; then
  echo "no previous image to restore — fix by hand" >&2
  exit 1
fi

echo "restoring $current" >&2
if switch_to "$current"; then
  echo "rolled back to $current" >&2
else
  echo "ROLLBACK FAILED too — the panel is down, fix it by hand" >&2
fi
exit 1
