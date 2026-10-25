#!/usr/bin/env bash
# Secret scan, run by the pre-commit hook.
#
# gitleaks is optional on purpose: this runs on machines that do not have it, and
# a hook must never be able to break a build or a commit on its own. A missing
# binary skips the scan with a hint (exit 0); a finding blocks (exit 1).
#
#   scripts/check-secrets.sh          # staged changes only, what the hook runs
#   scripts/check-secrets.sh --all    # every file in the tree, a manual sweep
set -eu

mode=staged
case "${1:-}" in
  "" | --staged) ;;
  --all) mode=all ;;
  *)
    echo "check-secrets: unknown argument '$1' (expected --staged or --all)" >&2
    exit 2
    ;;
esac

if ! command -v gitleaks >/dev/null 2>&1; then
  echo "check-secrets: gitleaks not installed, secret scan skipped" >&2
  echo "check-secrets: install it (brew install gitleaks) to enable the scan" >&2
  exit 0
fi

# gitleaks v8.19 renamed protect/detect to git/dir, so accept both shapes.
scan() {
  if [ "$mode" = staged ]; then
    if gitleaks git --help >/dev/null 2>&1; then
      gitleaks git --pre-commit --staged --redact --no-banner -v
    else
      gitleaks protect --staged --redact --no-banner -v
    fi
  else
    if gitleaks dir --help >/dev/null 2>&1; then
      gitleaks dir . --redact --no-banner -v
    else
      gitleaks detect --no-git --redact --no-banner -v
    fi
  fi
}

if scan; then
  exit 0
fi

cat >&2 <<'MSG'

commit blocked: gitleaks found what looks like a credential.

  1. remove the value from the file, or replace it with a placeholder
  2. rotate it — treat it as public from the moment it was written
  3. if it really is a fixture, allowlist the path or rule in gitleaks.toml

`git commit --no-verify` skips this check; nothing else repeats it.
MSG
exit 1
