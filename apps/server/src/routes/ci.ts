import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, isNotNull } from 'drizzle-orm';
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
} from '../ci/workflow';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { deployments, repoHooks, serviceEnvs, services, users } from '../db/schema';
import type { CaddyAdmin } from '../caddy/admin';
import { runDeployment } from '../deploy/pipeline';
import type { DockerAdapter } from '../docker/adapter';
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
  now?: () => number;
}

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

const enableBody = z.object({ overwrite: z.boolean().default(false) });

const callbackBody = z.object({
  buildId: z.string().min(1),
  repo: z.string().min(1),
  runUrl: z.string().url().optional(),
  conclusion: z.string().optional(),
  digest: z.string().optional(),
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

  const image = imageRef(service.repoFullName, service.slug, sha);
  const deployment = db
    .insert(deployments)
    .values({
      serviceEnvId: serviceEnv.id,
      trigger,
      status: 'queued',
      commitSha: sha,
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

    const updated = db
      .update(deployments)
      .set({
        ...(auth.payload.digest ? { imageDigest: auth.payload.digest } : {}),
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
    // pull must not turn into a failed callback.
    if (!failed && deps.docker) {
      void runDeployment(
        { config, db, docker: deps.docker, admin: deps.admin ?? null },
        auth.payload.buildId,
      ).catch((error: unknown) => {
        console.error('[nodock] deploy pipeline failed', error);
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
