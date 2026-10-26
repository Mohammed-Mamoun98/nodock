/**
 * The workflow nodock commits into a user's repo. It is generic on purpose:
 * every value that changes per build arrives in the repository_dispatch payload,
 * so this file only needs to exist on the default branch once.
 *
 * `repository_dispatch` always runs the workflow from the default branch, and the
 * checkout uses the dispatched SHA — so a build of `feat/x` still builds `feat/x`.
 *
 * Three build strategies share one job, chosen by `strategy` in the payload:
 *
 *   dockerfile  today's build, unchanged
 *   next        nodock's own recipe: standalone image, `next start` image, or files
 *   static      install, build, tar the output directory, upload it
 *   railpack    Railpack's plan, built by the Railpack frontend
 *
 * Every step that is strategy-specific is guarded, so a dockerfile build runs the
 * same five steps it always did.
 */
export const WORKFLOW_VERSION = 3;

/**
 * Railpack's build frontend — the *package* is `railpack-frontend`, not a tag of
 * `railpack`, which is why the previous ref resolved to nothing.
 *
 * This is the fallback only: the workflow reads the version of the CLI that it just
 * installed and asks for the frontend of the same version. The two are released in
 * lockstep, and a plan written by 0.43 read by an older frontend fails with nothing
 * but `exit code: 2`.
 */
export const RAILPACK_FRONTEND = 'ghcr.io/railwayapp/railpack-frontend:v0.43.0';

/** Since which template version a workflow can build each strategy. */
const STRATEGY_SINCE: Record<string, number> = {
  dockerfile: 1,
  next: 2,
  static: 2,
  // v2 pointed at a frontend image that does not exist, so its railpack step always died.
  railpack: 3,
};

/**
 * Whether a file at WORKFLOW_PATH is the one nodock wrote.
 *
 * The marker matters for recovery: deleting a service removes nodock's webhook and
 * CI token but leaves this file in the repo (it is the user's code). Re-creating the
 * service then finds a workflow that already exists. Overwriting nodock's own file is
 * a re-sync; overwriting anything else at that path would destroy work the user wrote.
 */
export function isNodockWorkflow(content: string): boolean {
  const head = content.trimStart();
  return head.startsWith('name: nodock') && content.includes('Managed by nodock');
}

export function renderWorkflow(nodockUrl: string): string {
  const base = nodockUrl.replace(/\/$/, '');

  return `name: nodock
# Managed by nodock. Edits are detected and surfaced in the dashboard; deleting
# this file stops automatic deploys for every service in this repository.
# Template version: ${WORKFLOW_VERSION}. A workflow older than nodock's own is
# asked to re-sync before it is sent a strategy it does not understand.

on:
  repository_dispatch:
    types: [nodock-build]

permissions:
  contents: read
  packages: write

# Two pushes in a row build in order, so the older image never lands last.
concurrency:
  group: nodock-\${{ github.event.client_payload.image }}
  cancel-in-progress: false

env:
  NODOCK_URL: "${base}"
  BUILD_ID: \${{ github.event.client_payload.buildId }}
  STRATEGY: \${{ github.event.client_payload.strategy }}
  IMAGE: \${{ github.event.client_payload.image }}
  CONTEXT: \${{ github.event.client_payload.context }}
  OUTPUT_DIR: \${{ github.event.client_payload.outputDir }}
  NODOCK_CI_TOKEN: \${{ secrets.NODOCK_CI_TOKEN }}

jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - name: Notify start
        continue-on-error: true
        run: |
          curl -fsS --retry 3 --retry-connrefused --retry-delay 5 \\
            -X POST "$NODOCK_URL/api/ci/started" \\
            -H "Authorization: Bearer $NODOCK_CI_TOKEN" \\
            -H "Content-Type: application/json" \\
            -d '{"buildId":"\${{ github.event.client_payload.buildId }}","repo":"\${{ github.repository }}","runUrl":"\${{ github.server_url }}/\${{ github.repository }}/actions/runs/\${{ github.run_id }}"}'

      - uses: actions/checkout@v4
        with:
          ref: \${{ github.event.client_payload.sha }}

      - uses: docker/setup-buildx-action@v3

      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: \${{ github.actor }}
          password: \${{ secrets.GITHUB_TOKEN }}

      - name: Build and push (dockerfile)
        id: dockerfile
        if: \${{ github.event.client_payload.strategy == 'dockerfile' }}
        uses: docker/build-push-action@v6
        with:
          context: \${{ github.event.client_payload.context }}
          file: \${{ github.event.client_payload.dockerfile }}
          push: true
          tags: \${{ github.event.client_payload.image }}

      # ---- toolchain: what this repo needs, decided from the repo --------------
      - name: Read the toolchain
        if: \${{ github.event.client_payload.strategy != 'dockerfile' && github.event.client_payload.strategy != 'railpack' }}
        working-directory: \${{ github.event.client_payload.context }}
        run: |
          node <<'NODOCK'
          const fs = require('node:fs');
          const pkg = fs.existsSync('package.json')
            ? JSON.parse(fs.readFileSync('package.json', 'utf8'))
            : {};
          const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };

          let node = '22';
          const engines = pkg.engines && pkg.engines.node;
          if (engines) {
            const major = /(\\d+)/.exec(String(engines));
            if (major) node = major[1];
          } else if (fs.existsSync('.nvmrc')) {
            const major = /(\\d+)/.exec(fs.readFileSync('.nvmrc', 'utf8'));
            if (major) node = major[1];
          }

          const declared = String(pkg.packageManager || '').split('@')[0];
          let pm = declared || 'npm';
          if (fs.existsSync('bun.lock') || fs.existsSync('bun.lockb')) pm = 'bun';
          else if (fs.existsSync('pnpm-lock.yaml')) pm = 'pnpm';
          else if (fs.existsSync('yarn.lock')) pm = 'yarn';
          else if (declared) pm = declared;

          let framework = 'static';
          if (deps.next) framework = 'next';
          else if (deps.nuxt) framework = 'nuxt';
          else if (deps['@sveltejs/kit']) framework = 'sveltekit';
          else if (deps.astro) framework = 'astro';
          else if (deps.vite) framework = 'vite';
          else if (deps['react-scripts']) framework = 'cra';

          const env = process.env.GITHUB_ENV;
          fs.appendFileSync(env, 'NODE_VERSION=' + node + '\\n');
          fs.appendFileSync(env, 'PM=' + pm + '\\n');
          fs.appendFileSync(env, 'FRAMEWORK=' + framework + '\\n');
          console.log('node ' + node + ', ' + pm + ', ' + framework);
          NODOCK

      - uses: actions/setup-node@v4
        if: \${{ github.event.client_payload.strategy != 'dockerfile' && github.event.client_payload.strategy != 'railpack' }}
        with:
          node-version: \${{ env.NODE_VERSION }}

      - name: Prepare the package manager
        if: \${{ github.event.client_payload.strategy != 'dockerfile' && github.event.client_payload.strategy != 'railpack' }}
        run: |
          case "$PM" in
            bun) curl -fsSL https://bun.sh/install | bash; echo "$HOME/.bun/bin" >> "$GITHUB_PATH" ;;
            pnpm|yarn) corepack enable ;;
          esac

      - uses: actions/cache@v4
        if: \${{ github.event.client_payload.strategy == 'next' || github.event.client_payload.strategy == 'static' }}
        with:
          # Every package manager's store, unconditionally: an unused one simply
          # stays empty, and no expression has to know which one is in play.
          path: |
            ~/.npm
            ~/.bun/install/cache
            ~/.cache/yarn
            ~/.local/share/pnpm/store
            .next/cache
          key: nodock-\${{ hashFiles('**/package-lock.json', '**/pnpm-lock.yaml', '**/yarn.lock', '**/bun.lock', '**/bun.lockb') }}

      - name: Install
        if: \${{ github.event.client_payload.strategy == 'next' || github.event.client_payload.strategy == 'static' }}
        working-directory: \${{ github.event.client_payload.context }}
        run: |
          case "$PM" in
            bun) bun install --frozen-lockfile || bun install ;;
            # pnpm 12 fails the whole install when any dependency has a build
            # script the repo has not approved (ERR_PNPM_IGNORED_BUILDS), where
            # npm and yarn only warn. Turn the strictness off so a repo that
            # builds on a laptop also builds here; packages that really need
            # their postinstall still work, because they ship platform packages.
            pnpm) pnpm install --frozen-lockfile --config.strict-dep-builds=false ;;
            yarn) yarn install --immutable 2>/dev/null || yarn install ;;
            *) if [ -f package-lock.json ]; then npm ci; else npm install; fi ;;
          esac

      # ---- build-time variables: names, never chosen per row -------------------
      - name: Read build-time variables
        if: \${{ github.event.client_payload.strategy == 'next' || github.event.client_payload.strategy == 'static' }}
        working-directory: \${{ github.event.client_payload.context }}
        run: |
          curl -fsS "$NODOCK_URL/api/ci/build-env?buildId=$BUILD_ID" \\
            -H "Authorization: Bearer $NODOCK_CI_TOKEN" \\
            -o "$RUNNER_TEMP/build-env.json"
          BUILD_ENV="$RUNNER_TEMP/build-env.json" node -e '
            const fs = require("node:fs");
            const vars = JSON.parse(fs.readFileSync(process.env.BUILD_ENV, "utf8")).vars || {};
            const names = Object.keys(vars);
            for (const name of names) {
              fs.appendFileSync(process.env.GITHUB_ENV, name + "<<NODOCK_ENV\\n" + vars[name] + "\\nNODOCK_ENV\\n");
            }
            console.log(names.length + " build-time variables");
          '

      - name: Build
        if: \${{ github.event.client_payload.strategy == 'next' || github.event.client_payload.strategy == 'static' }}
        working-directory: \${{ github.event.client_payload.context }}
        env:
          NODE_ENV: production
          NEXT_TELEMETRY_DISABLED: "1"
          CI: "1"
        run: |
          case "$PM" in
            bun) bun run build ;;
            pnpm) pnpm run build ;;
            yarn) yarn build ;;
            *) npm run build ;;
          esac

      # ---- what the build actually produced ------------------------------------
      - name: Decide what to ship
        if: \${{ github.event.client_payload.strategy == 'next' || github.event.client_payload.strategy == 'static' }}
        working-directory: \${{ github.event.client_payload.context }}
        run: |
          if [ "$STRATEGY" = "next" ]; then
            if [ -d out ]; then
              echo "NODOCK_MODE=artifact" >> "$GITHUB_ENV"
              echo "NODOCK_FRAMEWORK=next-export" >> "$GITHUB_ENV"
              echo "OUTPUT_DIR=out" >> "$GITHUB_ENV"
            elif [ -f .next/standalone/server.js ]; then
              echo "NODOCK_MODE=image" >> "$GITHUB_ENV"
              echo "NODOCK_FRAMEWORK=next-standalone" >> "$GITHUB_ENV"
              echo "NEXT_VARIANT=standalone" >> "$GITHUB_ENV"
            else
              echo "NODOCK_MODE=image" >> "$GITHUB_ENV"
              echo "NODOCK_FRAMEWORK=next-start" >> "$GITHUB_ENV"
              echo "NEXT_VARIANT=start" >> "$GITHUB_ENV"
              echo "::warning::This build ships a ~700 MB image. Add output: 'standalone' to next.config to get ~220 MB."
            fi
          else
            echo "NODOCK_MODE=artifact" >> "$GITHUB_ENV"
            echo "NODOCK_FRAMEWORK=$FRAMEWORK" >> "$GITHUB_ENV"
            [ -n "$OUTPUT_DIR" ] || echo "OUTPUT_DIR=dist" >> "$GITHUB_ENV"
          fi

      # ---- static: one tarball, uploaded to nodock -----------------------------
      - name: Upload the site
        if: \${{ github.event.client_payload.strategy == 'next' || github.event.client_payload.strategy == 'static' }}
        working-directory: \${{ github.event.client_payload.context }}
        run: |
          if [ "\${NODOCK_MODE}" != "artifact" ]; then
            echo "nothing static to upload"
            exit 0
          fi
          OUT="\${OUTPUT_DIR:-dist}"
          if [ ! -d "$OUT" ]; then
            echo "the build produced no $OUT/ directory"
            exit 1
          fi
          tar -czf "$RUNNER_TEMP/site.tar.gz" -C "$OUT" .
          SHA="$(sha256sum "$RUNNER_TEMP/site.tar.gz" | cut -d' ' -f1)"
          curl -fsS --retry 3 --retry-connrefused --retry-delay 5 \\
            -X PUT "$NODOCK_URL/api/ci/artifact?buildId=$BUILD_ID" \\
            -H "Authorization: Bearer $NODOCK_CI_TOKEN" \\
            -H "Content-Type: application/gzip" \\
            -H "X-Artifact-Sha256: $SHA" \\
            --data-binary @"$RUNNER_TEMP/site.tar.gz"
          echo "NODOCK_ARTIFACT_BYTES=$(du -sb "$OUT" | cut -f1)" >> "$GITHUB_ENV"
          echo "uploaded $(du -sh "$OUT" | cut -f1) from $OUT/"

      # ---- next: a small image built from what the build produced --------------
      - name: Assemble the image context
        if: \${{ github.event.client_payload.strategy == 'next' }}
        working-directory: \${{ github.event.client_payload.context }}
        run: |
          if [ "\${NODOCK_MODE:-}" != "image" ]; then
            exit 0
          fi
          mkdir -p "$RUNNER_TEMP/image"
          if [ "\${NEXT_VARIANT}" = "standalone" ]; then
            cp -a .next/standalone/. "$RUNNER_TEMP/image/"
            mkdir -p "$RUNNER_TEMP/image/.next"
            cp -a .next/static "$RUNNER_TEMP/image/.next/static"
            [ -d public ] && cp -a public "$RUNNER_TEMP/image/public"
            cat > "$RUNNER_TEMP/image/Dockerfile" <<NODOCK
          FROM node:\${NODE_VERSION}-alpine
          WORKDIR /app
          ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
          RUN addgroup -g 1001 nodejs && adduser -u 1001 -G nodejs -S nextjs
          COPY --chown=nextjs:nodejs . ./
          USER nextjs
          EXPOSE 3000
          CMD ["node", "server.js"]
          NODOCK
          else
            cp -a package.json node_modules .next "$RUNNER_TEMP/image/"
            for extra in public next.config.js next.config.mjs next.config.ts .env.production; do
              [ -e "$extra" ] && cp -a "$extra" "$RUNNER_TEMP/image/"
            done
            cat > "$RUNNER_TEMP/image/Dockerfile" <<NODOCK
          FROM node:\${NODE_VERSION}-alpine
          WORKDIR /app
          ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
          RUN addgroup -g 1001 nodejs && adduser -u 1001 -G nodejs -S nextjs
          COPY --chown=nextjs:nodejs . ./
          USER nextjs
          EXPOSE 3000
          CMD ["node", "node_modules/.bin/next", "start"]
          NODOCK
          fi
          echo "image context: $(du -sh "$RUNNER_TEMP/image" | cut -f1)"

      - name: Build and push (next)
        if: \${{ github.event.client_payload.strategy == 'next' }}
        run: |
          if [ "\${NODOCK_MODE:-}" != "image" ]; then
            exit 0
          fi
          echo "building $NODOCK_FRAMEWORK image"
          # --load then push, not --push: the local image is what gives the size
          # printed below, and buildx refuses --load with --push.
          docker buildx build --load \\
            --tag "$IMAGE" \\
            --cache-from type=gha --cache-to type=gha,mode=max \\
            --file "$RUNNER_TEMP/image/Dockerfile" \\
            "$RUNNER_TEMP/image"
          docker push "$IMAGE"

      # ---- railpack: everything else, detected by Railpack --------------------
      - name: Install Railpack
        if: \${{ github.event.client_payload.strategy == 'railpack' }}
        run: |
          curl -sSL https://railpack.com/install.sh | sh -s -- -y
          # The install script gives the newest CLI, so the frontend that reads its plan
          # has to be the matching release: a plan and a frontend from different versions
          # fail inside BuildKit with no message but the exit code.
          RAILPACK_VERSION="$(railpack --version | grep -oE '[0-9]+\\.[0-9]+\\.[0-9]+' | head -n1)"
          echo "NODOCK_RAILPACK_FRONTEND=ghcr.io/railwayapp/railpack-frontend:v\${RAILPACK_VERSION:-0.43.0}" >> "$GITHUB_ENV"

      - name: Prepare the Railpack plan
        if: \${{ github.event.client_payload.strategy == 'railpack' }}
        working-directory: \${{ github.event.client_payload.context }}
        run: |
          railpack prepare --plan-out plan.json --info-out info.json .
          PROVIDER="$(node -e 'const i=require(process.cwd()+"/info.json");console.log(i.providers?.[0]?.name||i.provider?.name||"railpack")')"
          echo "NODOCK_FRAMEWORK=\${PROVIDER}" >> "$GITHUB_ENV"
          echo "NODOCK_MODE=image" >> "$GITHUB_ENV"
          echo "railpack: \${PROVIDER}"

      - name: Build and push (railpack)
        if: \${{ github.event.client_payload.strategy == 'railpack' }}
        working-directory: \${{ github.event.client_payload.context }}
        run: |
          docker buildx build --load \\
            --tag "$IMAGE" \\
            --build-arg BUILDKIT_SYNTAX=\${NODOCK_RAILPACK_FRONTEND} \\
            --cache-from type=gha --cache-to type=gha,mode=max \\
            --file plan.json .
          docker push "$IMAGE"

      # ---- one fact per deployment: how big it is, and which digest it is -----
      - name: Record the image
        run: |
          # The dockerfile strategy is built by the action above, which reports the
          # registry digest itself; everything else was built and pushed by hand.
          if [ "$STRATEGY" = "dockerfile" ]; then
            echo "NODOCK_FRAMEWORK=dockerfile" >> "$GITHUB_ENV"
            echo "NODOCK_DIGEST=\${{ steps.dockerfile.outputs.digest }}" >> "$GITHUB_ENV"
            exit 0
          fi
          if [ "\${NODOCK_MODE:-}" != "image" ]; then
            exit 0
          fi
          BYTES="$(docker image inspect "$IMAGE" --format '{{.Size}}')"
          DIGEST="$(docker buildx imagetools inspect "$IMAGE" --format '{{.Manifest.Digest}}')"
          echo "NODOCK_IMAGE_BYTES=\${BYTES}" >> "$GITHUB_ENV"
          echo "NODOCK_DIGEST=\${DIGEST}" >> "$GITHUB_ENV"
          echo "image $(numfmt --to=iec "$BYTES" 2>/dev/null || echo "$BYTES") bytes, digest \${DIGEST}"

      - name: Notify result
        if: always()
        continue-on-error: true
        run: |
          PAYLOAD="$(jq -cn \\
            --arg buildId "$BUILD_ID" \\
            --arg repo "\${{ github.repository }}" \\
            --arg conclusion "\${{ job.status }}" \\
            --arg runUrl "\${{ github.server_url }}/\${{ github.repository }}/actions/runs/\${{ github.run_id }}" \\
            --arg digest "\${NODOCK_DIGEST:-}" \\
            --arg mode "\${NODOCK_MODE:-}" \\
            --arg framework "\${NODOCK_FRAMEWORK:-}" \\
            --arg imageBytes "\${NODOCK_IMAGE_BYTES:-}" \\
            --arg artifactBytes "\${NODOCK_ARTIFACT_BYTES:-}" \\
            '{buildId:$buildId, repo:$repo, conclusion:$conclusion, runUrl:$runUrl, digest:$digest, mode:$mode, framework:$framework, imageBytes:$imageBytes, artifactBytes:$artifactBytes}')"
          curl -fsS --retry 3 --retry-connrefused --retry-delay 5 \\
            -X POST "$NODOCK_URL/api/ci/finished" \\
            -H "Authorization: Bearer $NODOCK_CI_TOKEN" \\
            -H "Content-Type: application/json" \\
            -d "$PAYLOAD"
`;
}

export const WORKFLOW_PATH = '.github/workflows/nodock.yml';
export const CI_SECRET_NAME = 'NODOCK_CI_TOKEN';

/** Immutable image reference: one package per repo, one tag per service+commit. */
export function imageRef(repoFullName: string, serviceSlug: string, sha: string): string {
  const [owner] = repoFullName.toLowerCase().split('/');
  const name = repoFullName.toLowerCase().split('/')[1] ?? '';
  return `ghcr.io/${owner}/${name}:${serviceSlug}-${sha.slice(0, 12).toLowerCase()}`;
}

export interface DispatchPayload {
  buildId: string;
  ref: string;
  sha: string;
  image: string;
  dockerfile: string;
  context: string;
  serviceSlug: string;
  /** `dockerfile` | `next` | `static` | `railpack`. */
  strategy: string;
  /** Static only; empty means "the recipe's default". */
  outputDir: string;
}

/** GitHub allows at most 10 top-level properties and 64 KB total. */
export function assertDispatchPayload(payload: DispatchPayload): DispatchPayload {
  const keys = Object.keys(payload);
  if (keys.length > 10)
    throw new Error(`Dispatch payload has ${keys.length} keys, GitHub allows 10`);
  if (JSON.stringify(payload).length > 64 * 1024) throw new Error('Dispatch payload exceeds 64 KB');
  return payload;
}

/**
 * A v2 workflow understands `strategy`; a v1 one would build the Dockerfile and
 * silently ship the wrong thing. Refusing is the smaller failure.
 *
 * Per strategy rather than one global version: a repo still on v2 can build next and
 * static perfectly well, and does not deserve to be blocked from deploying while it
 * waits for a re-sync.
 */
export function workflowSupportsStrategy(
  version: number | null | undefined,
  strategy: string,
): boolean {
  const since = STRATEGY_SINCE[strategy];
  if (since === undefined) return true;
  return (version ?? 1) >= since;
}
