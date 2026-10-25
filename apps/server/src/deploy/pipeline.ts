import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, desc, eq, ne } from 'drizzle-orm';
import { decrypt, deriveKey } from '../auth/crypto';
import type { CaddyAdmin } from '../caddy/admin';
import { buildRoutes, renderCurrentConfig, type PendingRoute } from '../caddy/service';
import { artifactRoot, renderCaddyfile } from '../caddy/render';
import type { Config } from '../config';
import type { Db } from '../db/client';
import type { DeployLogs } from './deploy-log';
import { deployments, serviceEnvs, services, variables } from '../db/schema';
import type { DockerAdapter } from '../docker/adapter';
import { containerName } from '../docker/adapter';
import { explainPullFailure } from './pull-error';

const REGISTRY = 'ghcr.io';
/** One login per process: the daemon keeps the credential in /data/docker. */
const loggedIn = new Set<string>();
const SHA256 = /^sha256:[0-9a-f]{64}$/i;

/**
 * Pull by digest when CI reported one: a tag can be repointed, a digest cannot.
 * Rollback depends on this — the tag it was built from may since have moved.
 */
export function imageForPull(ref: string, digest: string | null | undefined): string {
  if (!digest || !SHA256.test(digest)) return ref;
  return `${ref.replace(/:[^/:]+$/, '')}@${digest.toLowerCase()}`;
}

export type DeployOutcome = 'live' | 'failed' | 'skipped';

export interface DeployDeps {
  config: Config;
  db: Db;
  docker: DockerAdapter;
  admin: CaddyAdmin | null;
  /** Injectable for tests; resolves once the container answers (or gives up). */
  health?: (url: string) => Promise<boolean>;
  now?: () => number;
  /** Deploy log sink; absent in tests that do not care about output. */
  logs?: DeployLogs;
}

interface Env {
  [key: string]: string;
}

/**
 * The state machine from the plan:
 *   queued → pulling → starting → healthchecking → switching → live
 * Any failure stops the old container untouched and marks the deployment failed.
 */
export async function runDeployment(
  deps: DeployDeps,
  deploymentId: string,
): Promise<DeployOutcome> {
  const { config, db, docker, admin } = deps;
  const now = deps.now ?? (() => Date.now());
  const log = (id: string, line: string) => deps.logs?.append(id, line);

  const deployment = db.select().from(deployments).where(eq(deployments.id, deploymentId)).get();
  if (!deployment) return 'skipped';

  // Supersede anything still *waiting* for this service env — but never the row we
  // are about to run, which is still `queued` at this point.
  db.update(deployments)
    .set({
      status: 'cancelled',
      error: 'superseded by a newer deployment',
      finishedAt: new Date(now()),
    })
    .where(
      and(
        eq(deployments.serviceEnvId, deployment.serviceEnvId),
        eq(deployments.status, 'queued'),
        ne(deployments.id, deploymentId),
      ),
    )
    .run();

  const serviceEnv = db
    .select()
    .from(serviceEnvs)
    .where(eq(serviceEnvs.id, deployment.serviceEnvId))
    .get();
  const service = serviceEnv
    ? db.select().from(services).where(eq(services.id, serviceEnv.serviceId)).get()
    : null;
  const environment = serviceEnv ? { id: serviceEnv.environmentId } : null;

  if (!serviceEnv || !service || !environment) {
    fail(db, deploymentId, 'Service env disappeared before deploy', now());
    return 'failed';
  }

  // An artifact deployment never pulls, starts or probes a container: the build
  // already delivered the files. The two paths share only the switch.
  if (deployment.mode === 'artifact') {
    return runArtifactDeployment(deps, deployment.id);
  }

  // An unset port is resolved from the image's EXPOSE after the pull, which is the
  // only moment the image metadata is available and trustworthy.
  let port = service.containerPort ?? 0;
  const name = containerName(service.slug, 'prod', deployment.id);
  const image = imageForPull(deployment.imageRef, deployment.imageDigest);

  const previous = db
    .select()
    .from(deployments)
    .where(and(eq(deployments.serviceEnvId, serviceEnv.id), eq(deployments.status, 'live')))
    .orderBy(desc(deployments.createdAt))
    .get();

  const setStatus = (status: typeof deployment.status, patch: Partial<typeof deployment> = {}) => {
    db.update(deployments)
      .set({ status, ...patch })
      .where(eq(deployments.id, deploymentId))
      .run();
  };

  /** True once a temporary probe route is loaded, so its removal is the only cleanup. */
  let probeLoaded = false;

  try {
    // Recorded before anything else: the UI needs a path to poll while the deploy
    // is still running, and the file is created by the first append below.
    setStatus('pulling', {
      startedAt: new Date(now()),
      logPath: deps.logs?.pathFor(deploymentId) ?? null,
    });
    log(deploymentId, `pulling ${image}`);

    await ensureRegistryLogin(deps);
    const pulled = await docker.pull(image, (line) => log(deploymentId, line));
    if (!pulled.ok) {
      const explanation = explainPullFailure(pulled.error ?? 'pull failed', config);
      log(deploymentId, explanation);
      fail(db, deploymentId, explanation, now());
      return 'failed';
    }

    if (!port) {
      const exposed = docker.exposedPorts ? await docker.exposedPorts(image) : [];
      const chosen = exposed.length === 1 ? exposed[0] : 0;
      if (chosen) {
        port = chosen;
        db.update(services).set({ containerPort: chosen }).where(eq(services.id, service.id)).run();
        log(deploymentId, `container port ${chosen} taken from the image's EXPOSE`);
      } else {
        port = 3000;
        log(
          deploymentId,
          exposed.length === 0
            ? 'image declares no EXPOSE; using 3000 — set the container port if that is wrong'
            : `image exposes ${exposed.join(', ')}; using 3000 — set the container port explicitly`,
        );
      }
    }

    setStatus('starting', { containerName: name });
    const envFile = writeEnvFile(config.paths.envDir, deployment.id, envFor(deps, serviceEnv.id));
    log(deploymentId, `starting ${name} on port ${port}`);

    await docker.run({
      name,
      image,
      envFile,
      network: config.dockerNetwork,
      memoryMb: service.memoryLimitMb ?? 512,
      labels: {
        'nodock.managed': 'true',
        'nodock.service': service.id,
        'nodock.service_env': serviceEnv.id,
        'nodock.deployment': deployment.id,
      },
    });
    rmSync(envFile, { force: true });

    setStatus('healthchecking');
    const healthPath = serviceEnv.healthPath ?? '/';
    let healthUrl = `http://${name}:${port}${healthPath}`;

    // nodock deliberately does not join the app network, so the proxy is the only
    // way to reach a container's HTTP port. The probe route exists for the length
    // of this health check only: the public route keeps serving the old container
    // until the new one answers.
    if (admin && config.caddy.probeUrl) {
      try {
        await admin.load(
          renderCurrentConfig({
            config,
            db,
            probe: { deploymentId: deployment.id, upstream: `${name}:${port}` },
          }),
        );
        probeLoaded = true;
      } catch (error) {
        await docker.remove(name).catch(() => {});
        fail(db, deploymentId, `Caddy rejected the health-check route: ${errorText(error)}`, now());
        return 'failed';
      }
      healthUrl = `${config.caddy.probeUrl}/probe/${deployment.id}${healthPath}`;
      log(deploymentId, `probing ${healthUrl}`);
    }

    const healthy = await (deps.health ?? defaultHealth)(healthUrl);
    if (!healthy) {
      // The container's own output is the only useful evidence here: wrong port,
      // crashed process, or bound to 127.0.0.1 all look identical from outside.
      const tail = docker.logs ? await docker.logs(name, 15).catch(() => '') : '';
      await docker.remove(name).catch(() => {});
      // Only re-render when the probe route is the thing that has to go: with no
      // probe, the route config was never touched and must stay untouched.
      if (probeLoaded) await reconcileClean(deps);
      fail(
        db,
        deploymentId,
        [
          `health check failed: no HTTP response from ${healthUrl} within 60s`,
          'Is the container port right, and does the app listen on 0.0.0.0?',
          tail ? `container said:\n${tail}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
        now(),
      );
      return 'failed';
    }

    setStatus('switching');
    const host = serviceEnv.customDomain ?? serviceEnv.generatedHost;
    const switched = await switchRoute(deps, { host, upstream: `${name}:${port}` });
    if (!switched) {
      await docker.remove(name).catch(() => {});
      fail(
        db,
        deploymentId,
        'Caddy rejected the route switch; previous container left serving',
        now(),
      );
      return 'failed';
    }

    setStatus('live', {
      finishedAt: new Date(now()),
      // Known without asking: the health check just passed on this container.
      runtimeState: 'running',
      runtimeExitCode: null,
      runtimeRestarts: 0,
      runtimeOom: false,
      runtimeCheckedAt: new Date(now()),
    });
    log(deploymentId, 'live');

    // Draining, not killing: SIGTERM then a 15s grace so in-flight requests finish.
    if (previous?.containerName && previous.containerName !== name) {
      await docker.stop(previous.containerName, 15).catch(() => {});
      await docker.remove(previous.containerName).catch(() => {});
    }

    // Older `live` rows for this env are history now: this deployment is the one
    // serving. Leaving them `live` is what made the panel list three green
    // deployments and none of them the container actually behind the route.
    db.update(deployments)
      .set({ status: 'superseded', runtimeState: null, runtimeCheckedAt: null })
      .where(
        and(
          eq(deployments.serviceEnvId, serviceEnv.id),
          eq(deployments.status, 'live'),
          ne(deployments.id, deploymentId),
        ),
      )
      .run();

    if (admin) await reconcileClean(deps);
    return 'live';
  } catch (error) {
    await docker.remove(name).catch(() => {});
    if (probeLoaded) await reconcileClean(deps);
    fail(db, deploymentId, errorText(error), now());
    return 'failed';
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The static path: there is nothing to pull and nothing to run. Validate what CI
 * uploaded, prove Caddy can read it, then switch the route. As with an image, any
 * failure leaves the previous deployment serving.
 */
async function runArtifactDeployment(
  deps: DeployDeps,
  deploymentId: string,
): Promise<DeployOutcome> {
  const { config, db, docker, admin } = deps;
  const now = deps.now ?? (() => Date.now());
  const log = (line: string) => deps.logs?.append(deploymentId, line);

  const deployment = db.select().from(deployments).where(eq(deployments.id, deploymentId)).get();
  if (!deployment) return 'skipped';

  const serviceEnv = db
    .select()
    .from(serviceEnvs)
    .where(eq(serviceEnvs.id, deployment.serviceEnvId))
    .get();
  const service = serviceEnv
    ? db.select().from(services).where(eq(services.id, serviceEnv.serviceId)).get()
    : null;

  if (!serviceEnv || !service) {
    fail(db, deploymentId, 'Service env disappeared before deploy', now());
    return 'failed';
  }

  const setStatus = (status: typeof deployment.status, patch: Partial<typeof deployment> = {}) => {
    db.update(deployments)
      .set({ status, ...patch })
      .where(eq(deployments.id, deploymentId))
      .run();
  };

  const previous = db
    .select()
    .from(deployments)
    .where(and(eq(deployments.serviceEnvId, serviceEnv.id), eq(deployments.status, 'live')))
    .orderBy(desc(deployments.createdAt))
    .get();

  let probeLoaded = false;

  try {
    setStatus('starting', {
      startedAt: new Date(now()),
      logPath: deps.logs?.pathFor(deploymentId) ?? null,
    });
    log('static deployment: no image, no container');

    const relative = deployment.artifactPath ?? `artifacts/${deployment.id}/site`;
    const site = join(config.paths.artifactsDir, deployment.id, 'site');
    const entries = existsSync(site) ? readdirSync(site) : [];

    if (entries.length === 0) {
      fail(
        db,
        deploymentId,
        'no artifact to serve: the build did not upload one, or the upload was rejected',
        now(),
      );
      return 'failed';
    }

    if (!entries.includes('index.html')) {
      log('warning: the artifact has no index.html at its root; the site will 404 at /');
    }
    log(
      `serving ${entries.length} top-level entr${entries.length === 1 ? 'y' : 'ies'} from ${relative}`,
    );

    // The root has to be the one Caddy mounts, not the one nodock writes: a
    // missing volume mounts fine and 404s, which is a confusing failure to debug
    // from the browser, so it is proved here first.
    const root = artifactRoot(relative, config.caddy.artifactsRoot);
    let healthUrl: string | null = null;

    if (admin && config.caddy.probeUrl) {
      try {
        await admin.load(renderCurrentConfig({ config, db, probe: { deploymentId, root } }));
        probeLoaded = true;
      } catch (error) {
        fail(
          db,
          deploymentId,
          `Caddy rejected the static health-check route: ${errorText(error)}`,
          now(),
        );
        return 'failed';
      }
      healthUrl = `${config.caddy.probeUrl}/probe/${deployment.id}/index.html`;
      log(`probing ${healthUrl}`);
    }

    if (healthUrl) {
      setStatus('healthchecking');
      const healthy = await (deps.health ?? defaultHealth)(healthUrl);
      if (!healthy) {
        if (probeLoaded) await reconcileClean(deps);
        fail(
          db,
          deploymentId,
          [
            `Caddy could not serve the site from ${root}`,
            'The artifacts volume is probably not mounted into Caddy — run the doctor.',
          ].join('\n'),
          now(),
        );
        return 'failed';
      }
    }

    setStatus('switching');
    const host = serviceEnv.customDomain ?? serviceEnv.generatedHost;
    const switched = await switchRoute(deps, {
      host,
      root,
      spaFallback: service.spaFallback ?? false,
    });

    if (!switched) {
      if (probeLoaded) await reconcileClean(deps);
      fail(db, deploymentId, 'Caddy rejected the route switch; previous site left serving', now());
      return 'failed';
    }

    setStatus('live', {
      finishedAt: new Date(now()),
      // Recorded as-is: there is no container, so there is nothing for the runtime
      // watchdog to inspect and nothing for it to call crashed.
      runtimeState: null,
      runtimeExitCode: null,
      runtimeRestarts: null,
      runtimeOom: null,
      runtimeCheckedAt: null,
    });
    log('live');

    // A service can move from a Dockerfile to files. The old container is no
    // longer behind the route, so it is stopped rather than left running.
    if (previous?.containerName) {
      await docker.stop(previous.containerName, 15).catch(() => {});
      await docker.remove(previous.containerName).catch(() => {});
    }

    db.update(deployments)
      .set({ status: 'superseded', runtimeState: null, runtimeCheckedAt: null })
      .where(
        and(
          eq(deployments.serviceEnvId, serviceEnv.id),
          eq(deployments.status, 'live'),
          ne(deployments.id, deploymentId),
        ),
      )
      .run();

    if (admin) await reconcileClean(deps);
    return 'live';
  } catch (error) {
    if (probeLoaded) await reconcileClean(deps);
    fail(db, deploymentId, errorText(error), now());
    return 'failed';
  }
}

/**
 * Private packages need an authenticated daemon. The token goes in over stdin and
 * is remembered for the process lifetime; a failed login is not fatal here because
 * public packages pull fine without it.
 */
async function ensureRegistryLogin(deps: DeployDeps): Promise<void> {
  const { config, docker } = deps;
  const user = config.ghcr.user;
  const token = config.ghcr.token;

  if (!docker.login || !user || !token) return;

  const key = `${REGISTRY}:${user}`;
  if (loggedIn.has(key)) return;

  try {
    await docker.login(REGISTRY, user, token);
    loggedIn.add(key);
  } catch (error) {
    // Surfaces later as the pull failure, which explainPullFailure turns into advice.
    void error;
  }
}

function fail(db: Db, deploymentId: string, message: string, at: number) {
  db.update(deployments)
    .set({ status: 'failed', error: message.slice(0, 500), finishedAt: new Date(at) })
    .where(eq(deployments.id, deploymentId))
    .run();
}

function envFor(deps: DeployDeps, serviceEnvId: string): Env {
  const key = deriveKey(deps.config.secret);
  const rows = deps.db
    .select()
    .from(variables)
    .where(eq(variables.serviceEnvId, serviceEnvId))
    .all();

  const env: Env = {};
  for (const row of rows) {
    try {
      env[row.key] = decrypt(row.valueEnc, key);
    } catch {
      // A value we cannot decrypt is a broken secret, not a reason to deploy blind.
      throw new Error(`Cannot decrypt variable ${row.key} — NODOCK_SECRET changed?`);
    }
  }
  return env;
}

function writeEnvFile(envDir: string, deploymentId: string, env: Env): string {
  mkdirSync(envDir, { recursive: true, mode: 0o700 });
  const path = join(envDir, `${deploymentId}.env`);
  const body = Object.entries(env)
    .map(([key, value]) => `${key}=${value.replace(/\n/g, '\\n')}`)
    .join('\n');
  writeFileSync(path, `${body}\n`, { mode: 0o600 });
  return path;
}

async function defaultHealth(url: string, timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      // Sequential by design: poll, wait, poll again.
      // eslint-disable-next-line no-await-in-loop
      const response = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: 'manual' });
      // Any answer below 500 means the server is listening — a 404 on a health
      // path means the path is wrong, not that the container failed to boot.
      if (response.status < 500) return true;
    } catch {
      // not up yet
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return false;
}

async function switchRoute(deps: DeployDeps, pending: PendingRoute): Promise<boolean> {
  if (!deps.admin) return true; // host runs without Caddy (dev); nothing to switch

  const config = renderCaddyfile({
    dashboardHost: new URL(deps.config.url).host,
    dashboardUpstream: 'nodock:3000',
    askUrl: deps.config.caddy.askUrl,
    adminSocket: deps.config.caddy.adminSocket,
    adminUrl: deps.config.caddy.adminUrl,
    artifactsRoot: deps.config.caddy.artifactsRoot,
    routes: buildRoutes(deps.db, {
      pending,
      artifactsRoot: deps.config.caddy.artifactsRoot,
      artifactsDir: deps.config.paths.artifactsDir,
    }),
  });

  try {
    await deps.admin.load(config);
    return true;
  } catch {
    return false;
  }
}

async function reconcileClean(deps: DeployDeps): Promise<void> {
  if (!deps.admin) return;
  const config = renderCurrentConfig({ config: deps.config, db: deps.db });
  await deps.admin.load(config).catch(() => {});
}
