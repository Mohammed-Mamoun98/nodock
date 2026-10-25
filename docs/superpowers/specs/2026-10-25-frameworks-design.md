# Deploying apps that have no Dockerfile

Status: implemented 2026-10-25 (`feat/frameworks`). Date: 2026-10-25. Deviations in §Conformance.

## Intent

Today a service must bring a Dockerfile. Almost nobody writes one for a frontend, and the
platforms people compare nodock to (Vercel, Netlify) never ask. The service form currently
says "From a GitHub repository that has a Dockerfile", which is a wall, not a feature.

This adds three ways to deploy a repo without one, chosen by what the repo is:

- **Next.js** gets nodock's own optimized recipe — `output: 'standalone'`, a ~220 MB image.
- **Anything that builds to files** (Vite, Astro, Next `export`, CRA) gets no container at all:
  the build artifact is served by the same Caddy that already fronts every service.
- **Everything else** (Go, Python, PHP, Ruby, Nuxt, SvelteKit, monorepos of unknown shape)
  is handed to [Railpack](https://railpack.com), which detects the language and builds an image.

The user keeps the escape hatch they have now: a repo with a Dockerfile still wins.

## Decided, and by whom

- **Next is ours, not Railpack's.** Railpack's Next default is `next start` with full
  `node_modules`; it does not ship standalone. Owning the recipe is the only way to get both
  the small image and monorepo awareness later.
- **Railpack everywhere else.** Its value is breadth we refuse to maintain: provider detection,
  package managers, version resolution, apt/mise escapes for native modules.
- **Railpack's detection is the detector** for the long tail. `railpack info --format json`
  reports what it found without building; the result travels back to nodock and is shown.
- **Static never becomes a container.** Railpack serves static sites from a Caddy image; that
  is the one thing it does that nodock does better with a directory.
- **A missing `output: 'standalone'` is not a build failure.** The build produces the
  `next start` image instead, and the panel says how to get the smaller one.
- **Monorepos are a `TODO`, not a feature.** Standalone in a workspace needs
  `outputFileTracingRoot` and per-app paths; the recipe carries the comment and nothing else.

## Goals

- Create a service from a Next, Vite, Astro, Go, Python, PHP or Rails repo and deploy it
  without touching a Dockerfile.
- Every deployment still says which strategy built it and how big the result is.
- Static sites run zero containers, roll back like everything else, and cost disk only.
- Builds stay in GitHub Actions. Nothing new runs on the 2 GB box.

## Non-goals

- Multi-region, CDN, edge caching (see `README.md`; unchanged).
- Building on the VPS, buildpacks, or a build queue.
- A per-service custom build command UI.
- Monorepo Next (`outputFileTracingRoot`, Nx inference) — a `TODO` in the recipe.
- Preview deployments, volumes, replicas.

## Anti-goals

- A build that silently ships a 700 MB image when 220 MB was possible.
- A strategy that cannot be rolled back.
- Detection that only exists inside a build log. Whatever was detected is data in the panel.

## Strategies

One column on `services`, `strategy`:

| Value        | Chosen when                                 | Output                    | Runtime         |
| ------------ | ------------------------------------------- | ------------------------- | --------------- |
| `dockerfile` | repo has a Dockerfile, or the user picks it | image (as today)          | 1 container     |
| `next`       | `next` in dependencies                      | image, or artifact if SPA | 1 container / 0 |
| `static`     | Vite, Astro, CRA, generic `dist`            | artifact                  | 0 containers    |
| `railpack`   | anything else                               | image                     | 1 container     |

`strategy` defaults to `dockerfile`, so every existing service keeps behaving exactly as it does
now and the migration is a no-op.

Within `next`, the workflow decides between two image variants and one artifact, because only
`next build` knows the truth:

1. `out/` exists and `next.config` says `output: 'export'` → artifact (no container).
2. `.next/standalone/server.js` exists → standalone image.
3. otherwise → `next start` image, plus the advisory below.

## Detection

Two moments, and they are allowed to disagree:

**At create time** (the wizard), best effort, from the GitHub file listing and a few file reads:

```
next            → next in package.json dependencies
vite            → vite.config.{js,ts,mjs} or "vite build" in scripts
astro           → astro.config.{js,ts,mjs}
go              → go.mod
python          → requirements.txt / pyproject.toml / manage.py
php             → composer.json / artisan
ruby            → Gemfile
dockerfile      → findDockerfiles() finds one (today's behaviour; wins over all of the above)
```

This pre-fills the form: strategy, context (the directory holding `package.json`), output
directory, port. It is allowed to be wrong.

**At build time**, authoritative:

- `next`/`static`: the recipe reports what it actually produced (`standalone`, `next-start`,
  `static`) with the artifact size or image size.
- `railpack`: `railpack prepare --info-out info.json` runs on the runner; its provider, step
  names and start command are posted back. This is where "detected Go (railpack)" comes from.

Detection never decides whether a deploy is allowed, only what the workflow does.

## Build recipes

Everything below lives in `apps/server/src/ci/workflow.ts` as rendered text. `renderWorkflow`
grows a version constant (`WORKFLOW_VERSION = 2`) and the version is stored per repo, because a
v1 workflow in the wild must not receive a v2 payload (see **Rollout**).

### `dockerfile` — unchanged

`docker/build-push-action` against `context` + `dockerfile`, push to GHCR, report digest.

### `next`

```
node from .nvmrc | engines.node | 22 (LTS)
package manager from bun.lock | pnpm-lock.yaml | yarn.lock | package-lock.json
cache: package-manager store + .next/cache, keyed on lockfile hash
NEXT_TELEMETRY_DISABLED=1 next build   (with build-time variables in env)
```

Then, depending on what the build produced, either:

- **artifact**: `tar -czf site.tar.gz -C out .` → `PUT /api/ci/artifact` (see below).
- **image**: a ~14-line Dockerfile rendered inline in the workflow, printed to the log, never
  written to the repo:

  ```dockerfile
  FROM node:22-alpine
  WORKDIR /app
  ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
  RUN addgroup -g 1001 nodejs && adduser -u 1001 -G nodejs -S nextjs
  COPY --chown=nextjs:nodejs .next/standalone/ ./
  COPY --chown=nextjs:nodejs .next/static ./.next/static
  COPY --chown=nextjs:nodejs public ./public
  USER nextjs
  EXPOSE 3000
  CMD ["node", "server.js"]
  ```

  The `next start` variant swaps the first `COPY` for `package.json` + `node_modules` (prod
  only) + `.next` + config, and runs `node_modules/.bin/next start`.

Port stays 3000 unless the service overrides `containerPort`. Boot is ~1 s either way.

Node version rule: parse `engines.node` for its first major (a range like `>=20` takes 20); fall
back to `.nvmrc`, then 22. Package manager order: `packageManager` field, then
`bun.lock`/`bun.lockb`, `pnpm-lock.yaml`, `yarn.lock`, `package-lock.json`, then npm.

Expected sizes: standalone ≈ 220 MB, `next start` ≈ 650–700 MB, static export ≈ 10–30 MB.

### `static`

```
install → build → tar -czf site.tar.gz -C <outputDir> .
```

`outputDir` comes from the dispatch payload (default `dist`, `out` for Next export), detected at
create time from the framework. No image is built and `imageRef` is recorded but unused.

### `railpack`

```
curl -sSL https://railpack.com/install.sh | sh        # static binary, ~15 MB, no mise
railpack prepare --plan-out plan.json --info-out info.json .
docker buildx build --build-arg BUILDKIT_SYNTAX=ghcr.io/railwayapp/railpack:railpack-frontend \
  -f plan.json --push --tag $image --cache-from type=gha --cache-to type=gha
```

The frontend image is pinned by digest in the workflow template. `info.json` is trimmed to
`{ provider, steps, startCommand }` and posted back. A provider failure exits 1 and the
deployment fails with Railpack's own message — it is the only place a build error comes from a
tool we did not write, so the message is passed through verbatim.

Cheap escape hatches, unexposed in the UI for v1, are documented in `docs/CI.md`:
`RAILPACK_PACKAGES`, `RAILPACK_BUILD_APT_PACKAGES`, `RAILPACK_DEPLOY_APT_PACKAGES`,
`RAILPACK_START_CMD`, and a `railpack.json` in the repo.

Railpack builds get no build-time variables in v1: passing them as build args writes them into
image layers, and Railpack's own secret path needs a plan rewrite. A `railpack` service that
needs one gets a sentence saying so, not a silent empty value.

## Build-time variables

`next build` and `vite build` inline values. A runtime-only variable is useless to them, and the
environment's variables do not exist in Actions.

**A rule, not a toggle.** Any variable whose name matches one of these prefixes is sent to the
build; nothing else is:

```
NEXT_PUBLIC_  VITE_  REACT_APP_  EXPO_PUBLIC_  NUXT_PUBLIC_  PUBLIC_
```

The list is one constant (`BUILD_TIME_PREFIXES` in the server), used by the endpoint and by the
panel, so the two can never disagree. The panel shows a read-only `build` tag on matching rows.

Why a rule: a per-row switch means everyone forgets to flip it and then debugs a blank page. The
cost is accepted and visible: `PUBLIC_KEY` matches `PUBLIC_` and is baked into the artifact, so
the tag is there before the deploy, not discovered after it. A variable with no matching prefix
has no build-time escape hatch in v1; if that bites, a per-row override comes back as a column.

No new column: the set is computed per request, so a variable added later is included on the next
build. Values travel through the CI callback channel, never the dispatch payload (GitHub keeps
that payload; the callback token is repo-scoped and short-lived):

```
GET /api/ci/build-env?buildId=…     Authorization: Bearer NODOCK_CI_TOKEN
→ { "vars": { "NEXT_PUBLIC_API_URL": "…" } }
```

The endpoint resolves the deployment, verifies the token against its repo, returns only
name-matched rows, and logs the count, never the values. The panel warns once, above the list:
"Names starting with `NEXT_PUBLIC_`, `VITE_` and friends are baked into the build."

The workflow logs `N build-time variables` so a missing `NEXT_PUBLIC_*` is visible before someone
debugs a blank page.

## Artifact delivery

Static output is uploaded during the build, not pulled later:

```
PUT /api/ci/artifact?buildId=…
Authorization: Bearer NODOCK_CI_TOKEN
Content-Type: application/gzip
X-Artifact-Sha256: <hex>
body: tar.gz ≤ 100 MB, ≤ 20 000 entries, ≤ 1 GB uncompressed
```

Server side, in order: authenticate, resolve the deployment, stream to
`DATA_DIR/uploads/<buildId>.tar.gz` while hashing, compare the header, list entries with
`tar -tzf` and reject absolute paths, `..`, and symlinks, sum uncompressed sizes against the cap,
then extract to `DATA_DIR/artifacts/<deploymentId>/site/` and delete the tarball. Any rejection
fails the deployment with a sentence the panel can show.

`deployments` gains `artifactPath` (relative to `DATA_DIR`) and `artifactBytes`.

Caddy must see the files, so `compose.yml` gains a read-only mount on the Caddy service:

```yaml
volumes:
  - ${DATA_DIR:-./data}/artifacts:/srv/artifacts:ro
```

Serving from nodock itself was rejected: it would put every static request through the panel
process and tie site uptime to the control plane.

## Caddy

`CaddyRoute` gains an alternative to `upstream`:

```ts
export interface CaddyRoute {
  host: string;
  upstream?: string;
  /** Absolute path inside Caddy's filesystem. */
  root?: string;
  /** Serve index.html for unknown paths (SPA); default false. */
  spaFallback?: boolean;
}
```

Rendered as:

```
example.com {
  encode zstd gzip
  root * /srv/artifacts/<id>/site
  try_files {path} {path}/ /index.html     # only when spaFallback
  file_server
}
```

`root` is validated like `upstream` is today: `/^\/srv\/artifacts\/[0-9a-f-]{36}\/site$/`.
`spaFallback` defaults from detection (true for Vite/CRA/React Router, false for Astro and Next
export unless a `404.html` exists) and is editable per service.

When the build produced a `404.html`, the route also gets `handle_errors { rewrite * /404.html }`
so a missing page returns the site's own 404 instead of Caddy's plain one. (My call: `file_server`
has no custom-error setting, and a 404 page that silently returns 200 would be worse.)

Health for static reuses the private probe listener: a probe route with the same `root`, and the
pipeline asks for `/probe/<id>/index.html`. No container is started, so no `docker run` step
exists in this path at all.

## Data model

```ts
// services
strategy: text('strategy', { enum: ['dockerfile', 'next', 'static', 'railpack'] })
  .notNull()
  .default('dockerfile');
outputDir: text('output_dir'); // static only; null means "recipe default"

// deployments
mode: text('mode', { enum: ['image', 'artifact'] })
  .notNull()
  .default('image');
framework: text('framework'); // 'next', 'go', 'vite', … as reported by the build
artifactPath: text('artifact_path');
artifactBytes: integer('artifact_bytes');
imageBytes: integer('image_bytes');

// repo_hooks
workflowVersion: integer('workflow_version').notNull().default(1);
```

`imageRef` stays `NOT NULL`; for artifact deployments it records the tag that was planned and
never pushed. Rollback for a static deployment is a route switch to `artifactPath`, unchanged in
shape from today's digest rollback.

## Things that must learn about artifacts

Three places assume every live deployment has a container. All three need a branch:

- `watchdog.ts`: skip deployments with `mode = 'artifact'`. There is nothing to inspect, and
  `missing` must never be written for a site that is serving fine.
- `buildRoutes()` and boot reconciliation: a live artifact deployment contributes a `root` route
  from `artifactPath`, exactly as a live image deployment contributes an `upstream`.
- `teardown.ts` / service deletion: delete `DATA_DIR/artifacts/<deploymentId>/` when the row goes.
  The DB cascade cannot remove files.

## Deployment state machine

```
image:    queued → pulling → starting → healthchecking → switching → live
artifact: queued → starting (validate + extract) → switching → live
```

No new statuses. `pulling` and `healthchecking` simply do not occur for artifacts, and the panel
already derives its progress copy from the ordered list. Failure at any point leaves the old
route untouched.

## Workflow contract v2

Dispatch payload (GitHub caps it at 10 keys; this uses 8):

```json
{
  "buildId": "…",
  "ref": "main",
  "sha": "…",
  "image": "ghcr.io/owner/repo:slug-abc123",
  "strategy": "next",
  "context": ".",
  "outputDir": "dist",
  "dockerfile": "Dockerfile"
}
```

`finished` callback grows `mode`, `framework`, `imageBytes`, `artifactBytes`, `digest` (empty for
artifacts), all optional so a v1 workflow keeps working. Unknown keys are ignored by nodock's
validator, which is why the callback body is parsed permissively.

Dispatch is refused with `workflow_out_of_date` when `strategy != 'dockerfile'` and the repo's
`workflowVersion < 2`, with copy that says to re-sync from the CI panel. A v1 workflow given a
`next` payload would silently build the wrong thing, which is worse than a refusal.

## Panel

- New service wizard: strategy select (Auto / Dockerfile), shown as "detected Next.js →
  optimized build; you can switch to your Dockerfile", with output directory when static.
- Service header: a `next` / `static` / `railpack` / `dockerfile` badge.
- Deployment row: `mode`, size (`218 MB image`, `12 MB files`), framework as reported by the
  build.
- Advisory, non-blocking, on `next start` deployments: "This app builds a 700 MB image. Add
  `output: 'standalone'` to `next.config.ts` to get ~220 MB." Same string in the API payload.
- Variables tab: a read-only `build` tag on name-matched rows, plus the one-line warning; no
  toggle, because forgetting a toggle is the failure mode the rule exists to remove.

## Failure and advisory matrix

| Situation                           | Result                                             |
| ----------------------------------- | -------------------------------------------------- |
| no Dockerfile, unknown framework    | Railpack tries; its error is shown verbatim        |
| Next without `standalone`           | builds `next start`; amber advisory, not a failure |
| `out/` missing after a static build | build fails: "build produced no `dist/`"           |
| artifact over cap                   | build fails at upload with the limit named         |
| artifact has `..` or symlinks       | build fails; nothing written                       |
| Caddy missing the artifacts mount   | deploy fails at prepare; `doctor` reports it       |
| v1 workflow + non-docker strategy   | dispatch refused, panel offers re-sync             |

## Security

- The artifact endpoint uses the existing CI token, which is per repo and has no other power.
- Extraction is validated before it happens; the tarball never lands outside
  `DATA_DIR/artifacts/<uuid>/`.
- Caddy's artifacts mount is read-only. Static sites are public by definition; the mount exposes
  no panel state.
- Build-time variables leave nodock only over the CI callback channel, selected by name prefix.
  They are non-secret by construction: they end up readable in the artifact.
- `railpack` runs only inside the Actions runner; no new privileges on the box.

## Testing

Unit, no network:

- detection table: repo file lists → strategy (next/vite/astro/go/python/php/ruby/dockerfile)
- `renderWorkflow` snapshot for v2, and that a v1 payload still renders the old workflow
- standalone vs `next start` vs export Dockerfile selection
- artifact entry validation: absolute paths, `..`, symlink, size caps
- `CaddyRoute` render for root, root+SPA fallback, and rejection of a path outside `/srv/artifacts`
- payload stays ≤ 10 keys after `strategy` and `outputDir`

Integration (fakes, no Docker):

- static deploy switches the route without touching the Docker adapter
- rollback to an artifact re-points the route
- build-env endpoint returns only name-matched rows and never logs values

Render smoke: a service panel fixture for each strategy badge.

## Rollout

1. Schema migration; `strategy` defaults to `dockerfile`, every existing service unaffected.
2. Ship the v2 workflow template. Existing repos flip to `out_of_date` and the panel already
   offers the re-sync; nothing breaks if they don't.
3. Enable `static` first (no container path, easiest to verify), then `next`, then `railpack`.
4. Artifact retention: keep the newest 5 artifacts per service env, sweep older on boot and after
   each deploy; `doctor` reports total artifact bytes. A rollback to a pruned deployment fails
   with "artifact pruned" rather than a confusing 404. (My call; time-based retention can come
   later if 5 proves wrong.)

## Monorepo TODO (deliberately out)

Standalone in a workspace needs `outputFileTracingRoot` set to the repo root, and the recipe must
copy `apps/web/.next/static` and `apps/web/public` into `apps/web/.next/standalone`. The recipe
carries the comment where that goes. Detection already finds the workspace root from the
`package.json` that has `next` in it; until the recipe handles it, that app builds `next start`
and the panel says why.

## Calls I made, so they can be checked

- Artifact cap 100 MB compressed / 1 GB uncompressed / 20 000 entries — generous for a frontend,
  survivable on a 2 GB box.
- Retention: newest 5 per environment, prune-on-deploy. Time-based can wait.
- `railpack info` runs only on the `railpack` branch; other strategies report their own
  framework from the recipe. Paying 10 s and 15 MB on every Node build to name a language we
  already detected is not worth it.
- **Build-time variables are selected by name prefix**, never by a per-row toggle. Everyone
  forgetting a toggle is a worse failure than `PUBLIC_KEY` being visibly baked.
- Static health is a probe for `index.html`, not a HEAD of every asset.

## Future, if it bites

A non-matching variable needed at build time (say `SENTRY_AUTH_TOKEN` for source maps) has no
path in v1. The shape would be a `variables.build_time` override that can only add to the prefix
rule, never subtract — the tag and the warning already exist.

## Conformance: what was built differently

Recorded because each one is a decision, not an oversight:

- **Railpack's frontend is referenced by tag, not digest.** nodock cannot resolve a digest when it
  renders the workflow (a box with no registry access must still be able to write the file), and a
  digest frozen into every new checkout would silently stop receiving Railpack's fixes. The tag is
  one constant in `apps/server/src/ci/workflow.ts`, and changing it makes the panel report
  `out_of_date` — the same re-sync path as any other template change.
- **`services.spaFallback` exists.** "Editable per service" needs a column; the draft's data model
  omitted it. `null` means "decided at create time from detection".
- **`artifactPath` is stored relative to `DATA_DIR`** (`artifacts/<id>/site`) and rendered to
  `/srv/artifacts/<id>/site` for Caddy. One stored form, one rendered form, one validator.
- **Caddy mounts a dedicated `nodock_artifacts` volume at `/srv/artifacts:ro`**, rather than
  bind-mounting `${DATA_DIR}/artifacts` from the host: an install may keep `/data` in a named
  volume, where the draft's bind path does not exist. Same volume into nodock at
  `/data/artifacts`.
- **The 404 page is detected from the extracted files** (`existsSync(.../404.html)`) instead of
  being reported by the build. The build does not need another field, and the check costs one
  `stat` per static route.
- **The doctor grew a `static artifacts` check** — "nodock can write the directory". The other
  half (Caddy can read it) is not observable from inside the container, so the deploy proves it
  and the failure message names the volume.
- **No `imageBytes` for the dockerfile strategy.** `build-push-action` reports a digest but not a
  size, and loading every Dockerfile image on the runner to measure it is not free. Next and
  Railpack builds are loaded, measured and pushed, so those rows show a size.
- **A failed artifact upload marks the deployment failed immediately.** GitHub's callback can only
  say "the build failed"; the extraction error is the useful message, so it is written first and
  the finished callback leaves a failed row alone.
