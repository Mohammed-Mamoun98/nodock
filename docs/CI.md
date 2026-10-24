# CI: how a push becomes a running container

nodock does not build on your VPS. GitHub Actions builds the image; nodock pulls it,
runs it, and routes to it. This file explains the handshake and every credential involved.

## No GitHub App is involved

nodock uses a plain **OAuth App** owned by you (see `docs/DEPLOY.md` §3). Everything in this
document is created with _your_ user token, on _your_ repositories. There is nothing to
install, and nothing appears under Settings → GitHub Apps.

## The flow

```
push to main
   │
   ├─(1) GitHub → nodock   POST /webhooks/github        signed: x-hub-signature-256
   │        checks: known repo? valid signature? matching services? CI enabled?
   │        ignores pushes that only touch .github/workflows/nodock.yml
   │
   ├─(2) nodock → GitHub   POST /repos/{o}/{r}/dispatches   event_type: nodock-build
   │        payload: buildId, ref, sha, image, dockerfile, context, serviceSlug
   │        nodock writes a deployment row: queued
   │
   ├─(3) GitHub Actions    runs .github/workflows/nodock.yml
   │        checkout @ sha → buildx → build → push ghcr.io/{owner}/{repo}:{slug}-{sha12}
   │
   ├─(4) Actions → nodock  POST /api/ci/started   Bearer NODOCK_CI_TOKEN → stores the run URL
   │
   ├─(5) Actions → nodock  POST /api/ci/finished  conclusion + digest
   │        failure → deployment failed (with the run link)
   │        success → digest stored, deployment ready for the runner
   │
   └─(6) nodock: docker pull → docker run → health check → switch the Caddy route
```

## What nodock writes into your repository

| Artifact                       | Created with                     | Where it appears                           |
| ------------------------------ | -------------------------------- | ------------------------------------------ |
| `.github/workflows/nodock.yml` | Contents API (`workflow` scope)  | file tree + **Actions tab**                |
| `NODOCK_CI_TOKEN`              | Actions secrets API (sealed box) | Settings → Secrets and variables → Actions |
| push webhook                   | Hooks API (`repo` scope)         | Settings → Webhooks                        |

Because it is an ordinary committed file:

- you can read and edit it — nodock reports `modified` rather than overwriting your changes;
- you can delete it — automatic deploys stop and the CI panel says `modified: deleted`;
- a protected default branch may block the commit, and nodock reports that instead of failing silently.

## Credentials, and what each one can do

| Credential                   | Lives in                    | Created by                   | Power                                                |
| ---------------------------- | --------------------------- | ---------------------------- | ---------------------------------------------------- |
| OAuth App client id + secret | your `.env`                 | you, once                    | proves the server is the app                         |
| User token (`repo workflow`) | nodock DB, AES-256-GCM      | GitHub, at login             | repos, workflow commits, webhooks, dispatch, secrets |
| `NODOCK_CI_TOKEN`            | your repo's Actions secrets | **nodock**, on Enable CI     | only POST `/api/ci/started` and `/api/ci/finished`   |
| `GITHUB_TOKEN`               | injected by Actions         | GitHub                       | push the image to GHCR (`packages: write`)           |
| GHCR pull PAT (optional)     | your `.env`                 | you, only for private images | `docker pull`                                        |

`NODOCK_CI_TOKEN` is a callback handshake secret, not a GitHub credential. nodock keeps only its
SHA-256 hash and gives it nothing but the two callback endpoints. Anyone who can write to the repo
can read it and forge callbacks — the same people who can already push code — which is why it
grants nothing else.

## CI status the dashboard shows

| Status        | Meaning                                                           |
| ------------- | ----------------------------------------------------------------- |
| `not_enabled` | no workflow has been committed yet                                |
| `enabled`     | committed blob and content both match what nodock ships           |
| `out_of_date` | the file matches what we wrote, but nodock ships a newer template |
| `modified`    | the file changed (edited or deleted) since nodock wrote it        |

## What deleting a project or service does (and does not) touch

| In nodock                                                                                                                               | In your GitHub repo                                           |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| containers stopped and removed                                                                                                          | `.github/workflows/nodock.yml` **stays** — never auto-deleted |
| Caddy routes dropped                                                                                                                    | —                                                             |
| rows deleted (project, envs, services, deployments, variables)                                                                          | —                                                             |
| when it was the last service for that repo: the push webhook, the `NODOCK_CI_TOKEN` Actions secret and the `repo_hooks` row are revoked | the secret disappears from Settings → Actions secrets         |

The workflow file is deliberately left alone: nodock does not own your repository, and
committing a deletion on a project delete is destructive and surprising. Delete it yourself if
you want it gone; it does nothing without a dispatch, since its only trigger is
`repository_dispatch`.

## Known gap: no commit checks

`repository_dispatch` runs the workflow from the **default branch**, so the run belongs to that
branch's run list, not to the commit you pushed. Consequences:

- builds are visible in the **Actions tab** and in nodock, but **not** as a `nodock / build` check
  on the commit or PR;
- branch protection cannot require the nodock build.

Closing this needs nodock to POST commit statuses (`POST /repos/{o}/{r}/statuses/{sha}`,
context `nodock / build`) as the build progresses. Not implemented yet.

## Troubleshooting

| Symptom                            | Cause                                                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `repository_dispatch failed (404)` | the workflow is not on the default branch, or Actions is disabled for the repo                               |
| Deployment sits at `queued`        | the workflow started but never called back — check the run URL, and that the callback can reach `NODOCK_URL` |
| `pull 401` at deploy time          | private GHCR package without `GHCR_TOKEN`                                                                    |
| Enable fails with a 403            | token missing the `workflow` scope, or branch protection blocked the commit                                  |
| Re-enable then every webhook 401s  | should not happen: nodock reuses the stored webhook secret instead of rotating it                            |
