# External facts (M0)

Every claim needs a source URL. Unverified items stay listed as pending rather than guessed.

## 1. Scope required to commit `.github/workflows/*` — VERIFIED

**Decision (also on record):** keep OAuth App tokens **non-expiring**. No `offline_access`, no
"expiring user tokens" app setting. Reasons: single admin; the token is encrypted with
AES-256-GCM under a key derived from `NODOCK_SECRET`, so a stolen DB alone is inert; and rotating
single-use refresh tokens introduce a silent failure in webhook-triggered dispatches (two
concurrent refreshes revoke the family → deploys stop until manual re-login). Flip this when
multi-user, org repos with SSO, or a compliance requirement appears — the upgrade path is
`offline_access` + a refresh single-flight + two `users` columns.

**Question:** which OAuth scope does nodock need to create/update `.github/workflows/nodock.yml`
via the Contents API, and does it imply re-consent?

**Answer:** `workflow`, in addition to `repo`. `repo` alone is not sufficient.

> `workflow` — "Grants the ability to add and update GitHub Actions workflow files. Workflow files
> can be committed without this scope if the same file (with both the same path and contents) exists
> on another branch in the same repository."

Source: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps

Consequences for nodock:

- The authorize URL must request `scope=repo workflow` (`%20` separated).
- A workflow file that already exists with identical path _and_ contents on another branch can be
  committed without the scope — this is what makes the "template already on `main`" case work, but it
  cannot be relied on for the first commit, so the scope is required.
- Scopes are requested at authorize time by the app, not configured in the OAuth App settings, so
  upgrading an installed nodock to require `workflow` means the user re-runs the OAuth flow and
  re-consents. Store `X-OAuth-Scopes` (or compare after callback) and surface a
  "Reconnect GitHub (missing workflow scope)" state instead of failing at commit time.
- Users can grant _less_ than requested; the token records what was granted. nodock must treat
  "scope not granted" as a first-class error, not an exception path.

Related scopes confirmed on the same page:

- `repo` — includes repository webhooks, so per-repo `push` hook creation works with it.
- `read:packages` — GHCR download, which is why the pull PAT (not the OAuth token) carries it.
- `offline_access` — requests expiring tokens + refresh token; nodock does **not** ask for it, so the
  OAuth App token stays long-lived until revoked (accepted risk for a single-admin panel).

## 2. Actions secrets API (sealed box) — PENDING

## 3. GHCR package↔repo association for nested names — PENDING

## 4. `repository_dispatch` constraints — PENDING

## 5. Caddy `on_demand_tls { ask }` and `/load` semantics — PENDING
