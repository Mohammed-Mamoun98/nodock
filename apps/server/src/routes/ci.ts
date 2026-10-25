import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import { decrypt, deriveKey, encrypt } from '../auth/crypto';
import { GitHubHttpError, type GitHubClient } from '../auth/github';
import { sessionToken } from '../auth/token';
import {
  assertDispatchPayload,
  CI_SECRET_NAME,
  imageRef,
  renderWorkflow,
  WORKFLOW_PATH,
  WORKFLOW_VERSION,
  workflowSupportsStrategy,
} from '../ci/workflow';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { deployments, repoHooks, serviceEnvs, services, users, variables } from '../db/schema';
import type { CaddyAdmin } from '../caddy/admin';
import { extractArtifact, writeUpload } from '../deploy/artifact';
import type { DeployLogs } from '../deploy/deploy-log';
import { runDeployment } from '../deploy/pipeline';
import type { DockerAdapter } from '../docker/adapter';
import { buildTimeVariables } from '../lib/framework';
import { apiError, validationError } from '../http';
import { runDoctor } from '../doctor';
import { findServiceEnv } from './services';
import { z } from 'zod';

export interface CiDeps {
  config: Config;
  db: Db;
  github: GitHubClient;
  /** Present in a real install; tests inject fakes. */
  docker?: DockerAdapter;
  admin?: CaddyAdmin;
  /** Deploy log sink; the pipeline writes pull/start/health output here. */
  logs?: DeployLogs;
  /** Injectable in tests: resolves once a container answers (or gives up). */
  health?: (url: string) => Promise<boolean>;
  now?: () => number;
}

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

/** A deployment can be rolled back to only if its image actually ran. */
const ROLLBACKABLE = new Set(['live', 'superseded']);
const IN_FLIGHT = ['queued', 'pulling', 'starting', 'healthchecking', 'switching'] as const;

const enableBody = z.object({ overwrite: z.boolean().default(false) });

/** A v2 workflow sends numbers as strings and empty values for what it did not do. */
const optionalNumber = z.preprocess(
  (value) => (value === '' || value === null || value === undefined ? undefined : Number(value)),
  z.number().int().nonnegative().optional(),
);

const optionalMode = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.enum(['image', 'artifact']).optional(),
);

const callbackBody = z.object({
  buildId: z.string().min(1),
  repo: z.string().min(1),
  runUrl: z.string().url().optional(),
  conclusion: z.string().optional(),
  digest: z.string().optional(),
  // Present in v2 and optional forever: a v1 workflow in the wild still calls back.
  mode: optionalMode,
  framework: z.string().max(64).optional(),
  imageBytes: optionalNumber,
  artifactBytes: optionalNumber,
});

function requireOps(github: GitHubClient) {
  const missing = (
    [
      'getRepo',
      'getBranchHead',
      'getFile',
      'putFile',
      'putActionsSecret',
      'createWebhook',
      'dispatchBuild',
    ] as const
  ).filter((name) => typeof github[name] !== 'function');

  return missing.length === 0 ? null : missing;
}

/** Session-authenticated CI management: status, enable, manual deploy. */
export function registerCiRoutes(app: Hono, deps: CiDeps): void {
  const { config, db, github } = deps;
  const now = deps.now ?? (() => Date.now());

  // Same checks as `bun run doctor`, for the panel and for CI.
  app.get('/api/doctor', async (c) => {
    const report = await runDoctor({ config, db, docker: deps.docker, admin: deps.admin ?? null });
    return c.json(report, report.ok ? 200 : 503);
  });

  app.get('/api/repos/:owner/:repo/ci', async (c) => {
    const auth = sessionToken(db, config, c.req.header('cookie'), now());
    if (!auth) {
      const { status, body } = apiError('github_not_connected', 'Sign in again', 409);
      return c.json(body, status);
    }

    const repoFullName = `${c.req.param('owner')}/${c.req.param('repo')}`;
    const row = db.select().from(repoHooks).where(eq(repoHooks.repoFullName, repoFullName)).get();

    if (!row?.ciEnabledAt) {
      return c.json({ status: 'not_enabled' as const, workflowPath: WORKFLOW_PATH });
    }

    if (requireOps(github)) {
      return c.json({ status: 'unknown' as const, reason: 'GitHub client lacks CI operations' });
    }

    try {
      const info = await github.getRepo!(auth.token, repoFullName);
      const file = await github.getFile!(
        auth.token,
        repoFullName,
        WORKFLOW_PATH,
        info.defaultBranch,
      );

      if (!file) {
        return c.json({
          status: 'modified' as const,
          reason: 'workflow deleted from the default branch',
        });
      }
      if (file.sha !== row.workflowSha) {
        return c.json({
          status: 'modified' as const,
          reason: 'workflow edited since nodock wrote it',
        });
      }
      if (file.content !== renderWorkflow(config.url)) {
        return c.json({ status: 'out_of_date' as const, reason: 'nodock ships a newer workflow' });
      }

      return c.json({ status: 'enabled' as const, workflowPath: WORKFLOW_PATH });
    } catch (error) {
      if (error instanceof GitHubHttpError) {
        const { status, body } = apiError(
          'github_error',
          error.message,
          error.status === 429 ? 429 : 502,
        );
        return c.json(body, status);
      }
      throw error;
    }
  });

  app.post('/api/repos/:owner/:repo/ci/enable', async (c) => {
    const auth = sessionToken(db, config, c.req.header('cookie'), now());
    if (!auth) {
      const { status, body } = apiError('github_not_connected', 'Sign in again', 409);
      return c.json(body, status);
    }

    const missing = requireOps(github);
    if (missing) {
      const { status, body } = apiError(
        'github_ops_unavailable',
        `GitHub client is missing: ${missing.join(', ')}`,
        501,
      );
      return c.json(body, status);
    }

    const parsed = enableBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      const { status, body } = validationError(parsed.error.issues);
      return c.json(body, status);
    }

    const repoFullName = `${c.req.param('owner')}/${c.req.param('repo')}`;
    const workflow = renderWorkflow(config.url);

    try {
      const info = await github.getRepo!(auth.token, repoFullName);
      const existing = await github.getFile!(
        auth.token,
        repoFullName,
        WORKFLOW_PATH,
        info.defaultBranch,
      );

      if (existing && existing.content !== workflow && !parsed.data.overwrite) {
        return c.json(
          {
            error: {
              code: 'workflow_exists',
              message: 'A different workflow already exists at that path',
              details: { current: existing.content, preview: workflow },
            },
          },
          409,
        );
      }

      const committed = await github.putFile!(auth.token, repoFullName, {
        path: WORKFLOW_PATH,
        content: workflow,
        message: 'chore: add nodock CI workflow',
        branch: info.defaultBranch,
        ...(existing ? { sha: existing.sha } : {}),
      });

      const ciToken = randomBytes(32).toString('hex');
      await github.putActionsSecret!(auth.token, repoFullName, CI_SECRET_NAME, ciToken);

      const row = db.select().from(repoHooks).where(eq(repoHooks.repoFullName, repoFullName)).get();

      // Re-enabling must reuse the existing webhook secret, or GitHub keeps
      // signing with the old one and every delivery fails verification.
      const webhookSecret = row?.webhookSecretEnc
        ? decrypt(row.webhookSecretEnc, deriveKey(config.secret))
        : randomBytes(32).toString('hex');

      let hookId = row?.hookId ?? null;
      if (!hookId) {
        const hook = await github.createWebhook!(auth.token, repoFullName, {
          url: `${config.url}/webhooks/github`,
          secret: webhookSecret,
        });
        hookId = hook.id;
      }

      const values = {
        repoFullName,
        hookId,
        webhookSecretEnc: encrypt(webhookSecret, deriveKey(config.secret)),
        ciTokenHash: sha256(ciToken),
        workflowSha: committed.contentSha,
        // Bumped with the template: a repo holding v1 must not be sent a strategy
        // its workflow cannot build.
        workflowVersion: WORKFLOW_VERSION,
        ciEnabledAt: new Date(now()),
      };

      if (row) {
        db.update(repoHooks).set(values).where(eq(repoHooks.id, row.id)).run();
      } else {
        db.insert(repoHooks).values(values).run();
      }

      return c.json({
        status: 'enabled',
        workflowSha: committed.contentSha,
        workflowPath: WORKFLOW_PATH,
      });
    } catch (error) {
      if (error instanceof GitHubHttpError) {
        const { status, body } = apiError(
          error.status === 401 ? 'github_token_rejected' : 'github_error',
          error.message,
          error.status === 401 ? 401 : 502,
        );
        return c.json(body, status);
      }
      throw error;
    }
  });

  app.post('/api/services/:id/envs/:envId/deploy', async (c) => {
    const auth = sessionToken(db, config, c.req.header('cookie'), now());
    if (!auth) {
      const { status, body } = apiError('github_not_connected', 'Sign in again', 409);
      return c.json(body, status);
    }

    const serviceEnv = findServiceEnv(db, c.req.param('id'), c.req.param('envId'));
    if (!serviceEnv) {
      const { status, body } = apiError('not_found', 'Service environment not found', 404);
      return c.json(body, status);
    }

    const result = await startDeployment({ config, db, github, now }, serviceEnv.id, 'manual');
    if ('error' in result) {
      const { status, body } = apiError(
        result.error.code,
        result.error.message,
        result.error.status,
      );
      return c.json(body, status);
    }

    return c.json({ deployment: result.deployment }, 202);
  });

  // Rollback re-runs a past image. Nothing is rebuilt and GitHub is not involved:
  // the image is already in GHCR, and it runs with today's variables (code
  // rollback, not config rollback). The digest makes the "past image" exact.
  app.post('/api/services/:id/envs/:envId/deployments/:deploymentId/rollback', async (c) => {
    const { docker } = deps;
    if (!docker) {
      const { status, body } = apiError('docker_unavailable', 'Docker is not available', 503);
      return c.json(body, status);
    }

    const serviceEnv = findServiceEnv(db, c.req.param('id'), c.req.param('envId'));
    if (!serviceEnv) {
      const { status, body } = apiError('not_found', 'Service environment not found', 404);
      return c.json(body, status);
    }

    const target = db
      .select()
      .from(deployments)
      .where(eq(deployments.id, c.req.param('deploymentId')))
      .get();
    if (!target || target.serviceEnvId !== serviceEnv.id) {
      const { status, body } = apiError(
        'not_found',
        'Deployment not found for this environment',
        404,
      );
      return c.json(body, status);
    }

    // The newest live row is the one serving; older live rows are stragglers from
    // a version that did not retire them, and rolling back to one is legitimate.
    const current = db
      .select()
      .from(deployments)
      .where(and(eq(deployments.serviceEnvId, serviceEnv.id), eq(deployments.status, 'live')))
      .orderBy(desc(deployments.createdAt))
      .get();
    if (target.id === current?.id) {
      const { status, body } = apiError('already_live', 'That deployment is already serving', 409);
      return c.json(body, status);
    }

    if (!ROLLBACKABLE.has(target.status)) {
      const { status, body } = apiError(
        'not_rollbackable',
        'Only a deployment that once ran can be rolled back to',
        409,
      );
      return c.json(body, status);
    }

    const busy = db
      .select({ id: deployments.id })
      .from(deployments)
      .where(
        and(
          eq(deployments.serviceEnvId, serviceEnv.id),
          inArray(deployments.status, [...IN_FLIGHT]),
        ),
      )
      .get();
    if (busy) {
      const { status, body } = apiError(
        'deployment_in_progress',
        'Wait for the deployment in progress to finish',
        409,
      );
      return c.json(body, status);
    }

    const deployment = db
      .insert(deployments)
      .values({
        serviceEnvId: serviceEnv.id,
        trigger: 'rollback',
        status: 'queued',
        commitSha: target.commitSha,
        commitMessage: target.commitMessage,
        imageRef: target.imageRef,
        imageDigest: target.imageDigest,
        rollbackOf: target.id,
      })
      .returning()
      .get();

    // Not awaited: a pull can take a minute, and the panel polls the row.
    void runDeployment(
      {
        config,
        db,
        docker,
        admin: deps.admin ?? null,
        logs: deps.logs,
        health: deps.health,
        now,
      },
      deployment.id,
    )
      .catch((error: unknown) => {
        console.error('[nodock] rollback pipeline failed', error);
      })
      .finally(() => {
        deps.logs?.prune();
      });

    return c.json({ deployment }, 202);
  });
}

interface StartResult {
  deployment: typeof deployments.$inferSelect;
}

interface StartError {
  error: { code: string; message: string; status: 400 | 404 | 409 | 429 | 502 };
}

/** Shared by manual deploys and push webhooks. */
async function startDeployment(
  deps: CiDeps,
  serviceEnvId: string,
  trigger: 'manual' | 'push',
): Promise<StartResult | StartError> {
  const { config, db, github } = deps;
  const now = deps.now ?? (() => Date.now());

  const serviceEnv = db.select().from(serviceEnvs).where(eq(serviceEnvs.id, serviceEnvId)).get();
  if (!serviceEnv)
    return { error: { code: 'not_found', message: 'Service env not found', status: 404 } };

  const service = db.select().from(services).where(eq(services.id, serviceEnv.serviceId)).get();
  if (!service) return { error: { code: 'not_found', message: 'Service not found', status: 404 } };

  const hook = db
    .select()
    .from(repoHooks)
    .where(eq(repoHooks.repoFullName, service.repoFullName))
    .get();
  if (!hook?.ciEnabledAt) {
    return {
      error: {
        code: 'ci_not_enabled',
        message: 'Enable CI for this repository before deploying',
        status: 409,
      },
    };
  }

  // A v1 workflow would build the Dockerfile for a repo that has none and look
  // like it worked. Refusing, with the fix in the copy, is the smaller failure.
  if (!workflowSupportsStrategy(hook.workflowVersion, service.strategy)) {
    return {
      error: {
        code: 'workflow_out_of_date',
        message:
          'This repository still has the older nodock workflow. Re-sync it from the CI panel, then deploy again.',
        status: 409,
      },
    };
  }

  const missing = requireOps(github);
  if (missing) {
    return {
      error: {
        code: 'github_ops_unavailable',
        message: `Missing: ${missing.join(', ')}`,
        status: 502,
      },
    };
  }

  // Single-admin product: act with the first stored token. Multi-user would need
  // to resolve the token per owning user instead.
  const owner = db
    .select({ tokenEnc: users.tokenEnc })
    .from(users)
    .where(isNotNull(users.tokenEnc))
    .get();

  let adminToken: string | null = null;
  try {
    adminToken = owner?.tokenEnc ? decrypt(owner.tokenEnc, deriveKey(config.secret)) : null;
  } catch {
    adminToken = null;
  }
  if (!adminToken) {
    return {
      error: { code: 'github_not_connected', message: 'No GitHub token stored', status: 409 },
    };
  }

  let sha: string;
  try {
    sha = await github.getBranchHead!(adminToken, service.repoFullName, serviceEnv.branch);
  } catch (error) {
    return {
      error: {
        code: 'github_error',
        message: error instanceof Error ? error.message : 'Could not resolve the branch head',
        status: 502,
      },
    };
  }

  // Best effort: the commit subject makes the deployment list readable, but a
  // failure here must never block a deploy.
  const commitMessage = github.getCommitMessage
    ? await github.getCommitMessage(adminToken, service.repoFullName, sha).catch(() => null)
    : null;

  const image = imageRef(service.repoFullName, service.slug, sha);
  const deployment = db
    .insert(deployments)
    .values({
      serviceEnvId: serviceEnv.id,
      trigger,
      status: 'queued',
      commitSha: sha,
      commitMessage,
      imageRef: image,
    })
    .returning()
    .get();

  try {
    await github.dispatchBuild!(adminToken, service.repoFullName, 'nodock-build', {
      ...assertDispatchPayload({
        buildId: deployment.id,
        ref: serviceEnv.branch,
        sha,
        image,
        dockerfile: service.dockerfilePath,
        context: service.contextPath,
        serviceSlug: service.slug,
        strategy: service.strategy,
        outputDir: service.outputDir ?? '',
      }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'dispatch failed';
    db.update(deployments)
      .set({ status: 'failed', error: message, finishedAt: new Date(now()) })
      .where(eq(deployments.id, deployment.id))
      .run();

    return { error: { code: 'dispatch_failed', message, status: 502 } };
  }

  return { deployment };
}

/** Bearer-token callbacks and the GitHub webhook: registered before the session guard. */
export function registerCiCallbacks(app: Hono, deps: CiDeps): void {
  const { config, db } = deps;
  const now = deps.now ?? (() => Date.now());

  async function authorisedRepo(c: Context) {
    const header = c.req.header('authorization') ?? '';
    const token = header.replace(/^Bearer\s+/i, '');
    if (!token) return null;

    const body = await c.req.json().catch(() => null);
    const parsed = callbackBody.safeParse(body);
    if (!parsed.success) return null;

    const hash = sha256(token);
    const hook = db
      .select()
      .from(repoHooks)
      .where(eq(repoHooks.repoFullName, parsed.data.repo))
      .get();
    if (!hook?.ciTokenHash) return null;

    const expected = Buffer.from(hook.ciTokenHash);
    const received = Buffer.from(hash);
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;

    return { hook, payload: parsed.data };
  }

  /**
   * The CI token proves which repo is calling; the build id alone proves nothing.
   * Looked up by the token's own hash, exactly as sessions are.
   */
  function hookForToken(c: Context) {
    const token = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!token) return null;
    return db
      .select()
      .from(repoHooks)
      .where(eq(repoHooks.ciTokenHash, sha256(token)))
      .get();
  }

  /** The deployment a build id names, with the service and environment behind it. */
  function buildFor(buildId: string) {
    const deployment = db.select().from(deployments).where(eq(deployments.id, buildId)).get();
    if (!deployment) return null;

    const serviceEnv = db
      .select()
      .from(serviceEnvs)
      .where(eq(serviceEnvs.id, deployment.serviceEnvId))
      .get();
    if (!serviceEnv) return null;

    const service = db.select().from(services).where(eq(services.id, serviceEnv.serviceId)).get();
    if (!service) return null;

    return { deployment, serviceEnv, service };
  }

  // Values a bundler inlines have to exist during the build, and the build runs in
  // GitHub, where the environment's variables do not. They travel over this
  // callback channel — never the dispatch payload, which GitHub keeps — and only
  // names matching BUILD_TIME_PREFIXES are ever returned.
  app.get('/api/ci/build-env', (c) => {
    const hook = hookForToken(c);
    if (!hook) {
      const { status, body } = apiError('unauthorised', 'Invalid CI token', 401);
      return c.json(body, status);
    }

    const found = buildFor(c.req.query('buildId') ?? '');
    if (!found) {
      const { status, body } = apiError('not_found', 'No such build', 404);
      return c.json(body, status);
    }
    if (found.service.repoFullName !== hook.repoFullName) {
      const { status, body } = apiError('unauthorised', 'That build is not this repository', 401);
      return c.json(body, status);
    }

    const key = deriveKey(config.secret);
    const env: Record<string, string> = {};
    for (const row of db
      .select()
      .from(variables)
      .where(eq(variables.serviceEnvId, found.serviceEnv.id))
      .all()) {
      try {
        env[row.key] = decrypt(row.valueEnc, key);
      } catch {
        // A value we cannot decrypt is skipped rather than failing the build: the
        // deploy that follows will say NODOCK_SECRET is wrong, which is the root cause.
      }
    }

    const vars = buildTimeVariables(env);
    // Count, never values: this line is the only trace of a secret leaving nodock.
    console.log(
      `[nodock] build-env: ${Object.keys(vars).length} variables for ${found.deployment.id}`,
    );
    return c.json({ vars });
  });

  // Static output: uploaded during the build, validated before it is extracted, and
  // then served by Caddy straight from disk. Nothing here starts a container.
  app.put('/api/ci/artifact', async (c) => {
    const hook = hookForToken(c);
    if (!hook) {
      const { status, body } = apiError('unauthorised', 'Invalid CI token', 401);
      return c.json(body, status);
    }

    const buildId = c.req.query('buildId') ?? '';
    const found = buildFor(buildId);
    if (!found) {
      const { status, body } = apiError('not_found', 'No such build', 404);
      return c.json(body, status);
    }
    if (found.service.repoFullName !== hook.repoFullName) {
      const { status, body } = apiError('unauthorised', 'That build is not this repository', 401);
      return c.json(body, status);
    }

    const claimed = (c.req.header('x-artifact-sha256') ?? '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(claimed)) {
      const { status, body } = apiError(
        'artifact_sha256_required',
        'X-Artifact-Sha256 must carry the hex SHA-256 of the body',
        400,
      );
      return c.json(body, status);
    }

    const stream = c.req.raw.body;
    if (!stream) {
      const { status, body } = apiError('artifact_empty', 'The request had no body', 422);
      return c.json(body, status);
    }

    const tarballPath = join(config.paths.uploadsDir, `${buildId}.tar.gz`);
    const written = await writeUpload(stream, tarballPath);
    if (!written.ok) {
      const { status, body } = apiError(written.code, written.message, written.status);
      return c.json(body, status);
    }

    if (written.sha256 !== claimed) {
      rmSync(tarballPath, { force: true });
      const { status, body } = apiError(
        'artifact_hash_mismatch',
        'The artifact arrived corrupted: its SHA-256 does not match the header',
        422,
      );
      return c.json(body, status);
    }

    const extracted = extractArtifact({
      dataDir: config.paths.dataDir,
      uploadsDir: config.paths.uploadsDir,
      artifactsDir: config.paths.artifactsDir,
      deploymentId: buildId,
      tarballPath,
    });
    rmSync(tarballPath, { force: true });

    if (!extracted.ok) {
      // Failed here rather than at deploy time: the build's own callback can only
      // say "the build failed", and this message is the one that helps.
      db.update(deployments)
        .set({
          status: 'failed',
          error: extracted.message.slice(0, 500),
          finishedAt: new Date(now()),
        })
        .where(eq(deployments.id, buildId))
        .run();
      const { status, body } = apiError(extracted.code, extracted.message, extracted.status);
      return c.json(body, status);
    }

    db.update(deployments)
      .set({
        mode: 'artifact',
        artifactPath: extracted.artifactPath,
        artifactBytes: extracted.artifactBytes,
      })
      .where(eq(deployments.id, buildId))
      .run();

    return c.json({ ok: true, artifactBytes: extracted.artifactBytes }, 201);
  });

  app.post('/api/ci/started', async (c) => {
    const auth = await authorisedRepo(c);
    if (!auth) {
      const { status, body } = apiError(
        'unauthorised',
        'Invalid CI token for that repository',
        401,
      );
      return c.json(body, status);
    }

    const updated = db
      .update(deployments)
      .set(auth.payload.runUrl ? { ciRunUrl: auth.payload.runUrl } : {})
      .where(eq(deployments.id, auth.payload.buildId))
      .returning({ id: deployments.id })
      .get();

    if (!updated) {
      const { status, body } = apiError('not_found', 'No such build', 404);
      return c.json(body, status);
    }
    return c.json({ ok: true });
  });

  app.post('/api/ci/finished', async (c) => {
    const auth = await authorisedRepo(c);
    if (!auth) {
      const { status, body } = apiError(
        'unauthorised',
        'Invalid CI token for that repository',
        401,
      );
      return c.json(body, status);
    }

    const failed = auth.payload.conclusion !== 'success';

    // What the build delivered is a fact about the deployment, recorded before the
    // pipeline runs so the panel never shows an image badge on a files-only deploy.
    const built = {
      ...(auth.payload.digest ? { imageDigest: auth.payload.digest } : {}),
      ...(auth.payload.mode ? { mode: auth.payload.mode } : {}),
      ...(auth.payload.framework ? { framework: auth.payload.framework } : {}),
      ...(auth.payload.imageBytes === undefined ? {} : { imageBytes: auth.payload.imageBytes }),
      ...(auth.payload.artifactBytes === undefined
        ? {}
        : { artifactBytes: auth.payload.artifactBytes }),
    };

    const updated = db
      .update(deployments)
      .set({
        ...built,
        ...(auth.payload.runUrl ? { ciRunUrl: auth.payload.runUrl } : {}),
        ...(failed
          ? {
              status: 'failed' as const,
              error: `GitHub Actions build ${auth.payload.conclusion ?? 'failed'}`,
              finishedAt: new Date(now()),
            }
          : {}),
      })
      .where(eq(deployments.id, auth.payload.buildId))
      .returning({ id: deployments.id })
      .get();

    if (!updated) {
      const { status, body } = apiError('not_found', 'No such build', 404);
      return c.json(body, status);
    }

    // A build that passed CI now gets pulled, run, health-checked and routed.
    // Deliberately not awaited: GitHub is waiting on this response, and a slow
    // pull must not turn into a failed callback. A deployment already failed by
    // the artifact upload is left alone: its message is the useful one.
    const current = db
      .select({ status: deployments.status })
      .from(deployments)
      .where(eq(deployments.id, auth.payload.buildId))
      .get();

    if (!failed && deps.docker && current?.status !== 'failed') {
      void runDeployment(
        {
          config,
          db,
          docker: deps.docker,
          admin: deps.admin ?? null,
          logs: deps.logs,
          health: deps.health,
        },
        auth.payload.buildId,
      )
        .catch((error: unknown) => {
          console.error('[nodock] deploy pipeline failed', error);
        })
        .finally(() => {
          // Keeps the log directory bounded without a cron job on the box.
          deps.logs?.prune();
        });
    }

    return c.json({ ok: true });
  });

  app.post('/webhooks/github', async (c) => {
    const event = c.req.header('x-github-event') ?? '';
    const signature = c.req.header('x-hub-signature-256') ?? '';
    const raw = await c.req.text();

    let body: {
      repository?: { full_name?: string; default_branch?: string };
      ref?: string;
      after?: string;
      commits?: { added?: string[]; modified?: string[]; removed?: string[] }[];
    };
    try {
      body = JSON.parse(raw);
    } catch {
      return c.body('invalid json', 400);
    }

    const repoFullName = body.repository?.full_name;
    if (!repoFullName) return c.body('missing repository', 400);

    const hook = db.select().from(repoHooks).where(eq(repoHooks.repoFullName, repoFullName)).get();
    if (!hook?.webhookSecretEnc) return c.body('unknown repository', 404);

    const secret = decrypt(hook.webhookSecretEnc, deriveKey(config.secret));
    const expected = `sha256=${createHmac('sha256', secret).update(raw, 'utf8').digest('hex')}`;
    const expectedBuffer = Buffer.from(expected);
    const receivedBuffer = Buffer.from(signature);
    const valid =
      expectedBuffer.length === receivedBuffer.length &&
      timingSafeEqual(expectedBuffer, receivedBuffer);

    if (!valid) return c.body('bad signature', 401);
    if (event !== 'push') return c.body('ignored', 202);

    const branch = (body.ref ?? '').replace('refs/heads/', '');
    const touched: string[] = [];
    for (const commit of body.commits ?? []) {
      touched.push(...(commit.added ?? []), ...(commit.modified ?? []), ...(commit.removed ?? []));
    }

    // nodock's own workflow commit must not trigger a deployment of itself.
    if (touched.length > 0 && touched.every((path) => path === WORKFLOW_PATH)) {
      return c.body('ignored workflow-only push', 202);
    }

    const matching = db
      .select({ id: serviceEnvs.id })
      .from(serviceEnvs)
      .innerJoin(services, eq(services.id, serviceEnvs.serviceId))
      .where(and(eq(services.repoFullName, repoFullName), eq(serviceEnvs.branch, branch)))
      .all();

    const started: string[] = [];
    for (const row of matching) {
      // Sequential on purpose: each dispatch must complete before the next starts
      // so a failure can be attributed to a specific service env.
      // eslint-disable-next-line no-await-in-loop
      const result = await startDeployment(deps, row.id, 'push');
      if ('deployment' in result) started.push(result.deployment.id);
    }

    return c.json({ accepted: started.length }, 202);
  });
}
