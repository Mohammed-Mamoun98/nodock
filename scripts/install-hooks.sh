#!/usr/bin/env bash
# Points git at the committed hooks. Run by `bun install` (prepare) and on demand.
set -e
cd "$(dirname "$0")/.."
chmod +x .githooks/*
git config core.hooksPath .githooks
echo "git hooks enabled: core.hooksPath = .githooks"
