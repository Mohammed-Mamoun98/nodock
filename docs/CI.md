# CI: how a push becomes a running container

nodock does not build on your VPS. GitHub Actions builds the image; nodock pulls it,
runs it, and routes to it. This file explains the handshake and every credential involved.

Two logs, two places — worth knowing before you go looking for output:

| You want                                      | Where it is                                                                   |
| --------------------------------------------- | ----------------------------------------------------------------------------- |
| what the build did (`docker build` output)    | GitHub Actions; every deployment row links to its run (`Actions ↗`)           |
| what nodock did (pull, start, health, switch) | the panel: a deployment's **Log** button, streamed from `/data/logs/<id>.log` |
| what the app is printing right now            | the panel: **Logs** tab, streamed from `docker logs -f`                       |

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
   │        payload: buildId, ref, sha, image, dockerfile, context, serviceSlug,
   │                 strategy, outputDir
   │        nodock writes a deployment row: queued
   │
   ├─(3) GitHub Actions    runs .github/workflows/nodock.yml, one job, guarded steps
   │        checkout @ sha → the strategy decides what happens next
   │
   │        strategy=dockerfile → buildx → build → push ghcr.io/{o}/{r}:{slug}-{sha12}
   │        strategy=next       → install, build, then: image (standalone or `next start`)
   │                             or files (a static export)
   │        strategy=static     → install, build, tar the output directory
   │        strategy=railpack   → `railpack prepare`, then buildx with Railpack's frontend
   │
   ├─(3a) Actions → nodock GET /api/ci/build-env       (next and static only)
   │        names matching BUILD_TIME_PREFIXES only; they become build env vars
   │
   ├─(3b) Actions → nodock PUT /api/ci/artifact        (files, not images)
   │        tar.gz + X-Artifact-Sha256, validated entry by entry, extracted to
   │        /data/artifacts/<deployment id>/site
   │
   ├─(4) Actions → nodock  POST /api/ci/started   Bearer NODOCK_CI_TOKEN → stores the run URL
   │
   ├─(5) Actions → nodock  POST /api/ci/finished  conclusion + digest + mode + size
   │        failure → deployment failed (with the run link)
   │        success → digest stored, deployment ready for the runner
   │
   └─(6) nodock: image   → docker pull → docker run → health check → switch the route
             artifact → validate the files → probe through Caddy → switch the route
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
SHA-256 hash and gives it four endpoints: `started`, `finished`, `build-env` and `artifact`. Each
one resolves the build id to a deployment and refuses if that deployment's repo is not the token's
repo, so a token for one repository cannot read another's variables or upload another's site. Anyone who can write to the repo
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

## Strategies: what a repo without a Dockerfile becomes

| `strategy`   | Chosen when                              | The build produces                             | Runtime          |
| ------------ | ---------------------------------------- | ---------------------------------------------- | ---------------- |
| `dockerfile` | the repo has a Dockerfile, or you say so | an image                                       | one container    |
| `next`       | `next` is a dependency                   | standalone image, `next start` image, or files | container / none |
| `static`     | Vite, Astro, CRA, a `vite build` script  | a tarball of the output directory              | none             |
| `railpack`   | anything else                            | an image, built by Railpack                    | one container    |

Detection happens twice and the two are allowed to disagree: once at create time, from the file
listing, to prefill the form (it may be wrong), and once in the build, which reports what it
actually produced. **Nothing detected decides whether a deploy is allowed** — only what the
workflow does.

Next is split three ways at build time, because only `next build` knows which happened:

| The build found                  | It ships                      | The panel says                   |
| -------------------------------- | ----------------------------- | -------------------------------- |
| `out/` (i.e. `output: 'export'`) | files, no container           | `next-export · 12 MB files`      |
| `.next/standalone/server.js`     | a ~220 MB image               | `next-standalone · 218 MB image` |
| neither                          | a `next start` image, ~700 MB | an amber advisory, not a failure |

### Workflow versioning

The template carries a version (`WORKFLOW_VERSION`, currently 2) and `repo_hooks.workflow_version`
records which one a repo actually has. A `dockerfile` service still deploys against a v1 workflow;
anything else is refused with `workflow_out_of_date` and a "re-sync from the CI panel" message,
because a v1 workflow given a `next` payload would build a Dockerfile that is not there and then
report success. Re-syncing is the same Enable CI button; it overwrites only if you say so.

## Static output: the artifact channel

A static site is uploaded during the build, not pulled later:

```
PUT /api/ci/artifact?buildId=…       Authorization: Bearer NODOCK_CI_TOKEN
Content-Type: application/gzip       X-Artifact-Sha256: <hex>
body: tar.gz ≤ 100 MB, ≤ 20 000 entries, ≤ 1 GB uncompressed
```

In order: authenticate, resolve the deployment, refuse if the repo does not match, stream to
`/data/uploads/<buildId>.tar.gz` while hashing and enforcing the cap, compare the header, list
with `tar -tvzf`, reject absolute paths, `..`, symlinks, hard links and any entry type other than
file or directory, sum the uncompressed sizes, then extract to
`/data/artifacts/<deploymentId>/site/` and delete the tarball. A rejected upload marks the
deployment failed with the reason — GitHub's own "the build failed" would lose it.

Caddy serves that directory through a read-only volume:

```yaml
caddy:  - nodock_artifacts:/srv/artifacts:ro
nodock: - nodock_artifacts:/data/artifacts
```

Which means a static deploy's health check is "can Caddy read these files": the pipeline loads a
`file_server` probe route, fetches `/probe/<id>/index.html`, then switches the public route. There
is no container and nothing to `docker run`. Rolling back a static deployment is a route switch
back to the old `artifactPath`.

## Build-time variables

`next build` and `vite build` inline values, and the environment's variables do not exist in
Actions. So a variable whose name matches one of these prefixes is fetched over the CI channel and
exported for the build step — a rule, not a toggle:

```
NEXT_PUBLIC_  VITE_  REACT_APP_  EXPO_PUBLIC_  NUXT_PUBLIC_  PUBLIC_
```

The list is one constant in the server and travels to the panel with the variable list, so the
`build` tag and the endpoint that selects them cannot drift. The cost is visible and accepted:
`PUBLIC_KEY` is baked into the artifact and tagged before the deploy, not discovered after it.
Railpack builds get no build-time variables in v1 — its secret path needs a plan rewrite, and a
silent empty value would be worse than a sentence saying so.

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
