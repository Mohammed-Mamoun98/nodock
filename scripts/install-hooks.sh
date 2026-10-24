#!/bin/sh
# Enables the committed git hooks. Runs from `bun install` (prepare) and on demand.
#
# Deliberately POSIX sh and deliberately unable to fail: it also runs inside the
# Docker build, where there is no .git and no bash. A lifecycle script must never
# be able to break an image build.
set -e

cd "$(dirname "$0")/.." 2>/dev/null || true

if [ ! -d .git ]; then
  echo "hooks: no .git here (container build?), skipping"
  exit 0
fi

if ! command -v git >/dev/null 2>&1; then
  echo "hooks: git not installed, skipping"
  exit 0
fi

chmod +x .githooks/* 2>/dev/null || true
git config core.hooksPath .githooks
echo "git hooks enabled: core.hooksPath = .githooks"
