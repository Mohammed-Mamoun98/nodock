import { and, asc, count, desc, eq, inArray } from 'drizzle-orm';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { CaddyAdmin } from '../caddy/admin';
import type { Config } from '../config';
import type { Db } from '../db/client';
import type { DockerAdapter } from '../docker/adapter';
import {
  containerNamesFor,
  reconcileRoutes,
  serviceEnvIdsForEnvironment,
  serviceEnvIdsForProject,
  stopContainers,
} from '../deploy/teardown';
import { deployments, environments, projects, serviceEnvs, services } from '../db/schema';
import { apiError, validationError } from '../http';
import { slugify, uniqueValue } from '../lib/slug';

const name = z.string().trim().min(1).max(80);

const createProject = z.object({ name });
const patchProject = z.object({ name });
const createEnvironment = z.object({ name });

export interface ProjectDeps {
  config: Config;
  db: Db;
  docker?: DockerAdapter;
  admin?: CaddyAdmin | null;
}

const iso = (date: Date | null) => (date ? date.toISOString() : null);

export function serializeProject(row: typeof projects.$inferSelect) {
  return { id: row.id, name: row.name, slug: row.slug, createdAt: iso(row.createdAt) };
}

export function registerProjectRoutes(app: Hono, deps: ProjectDeps): void {
  const { db, config } = deps;

  app.get('/api/projects', (c) => {
    const rows = db
      .select({
        id: projects.id,
        name: projects.name,
        slug: projects.slug,
        createdAt: projects.createdAt,
        serviceCount: count(services.id),
      })
      .from(projects)
      .leftJoin(services, eq(services.projectId, projects.id))
      .groupBy(projects.id)
      .orderBy(asc(projects.createdAt))
      .all();

    return c.json({
      projects: rows.map((row) => ({
        id: row.id,
        name: row.name,
        slug: row.slug,
        serviceCount: row.serviceCount,
        createdAt: iso(row.createdAt),
      })),
    });
  });

  app.post('/api/projects', async (c) => {
    const parsed = createProject.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      const { status, body } = validationError(parsed.error.issues);
      return c.json(body, status);
    }

    const slug = uniqueValue(slugify(parsed.data.name, 'project'), (candidate) =>
      Boolean(
        db.select({ id: projects.id }).from(projects).where(eq(projects.slug, candidate)).get(),
      ),
    );

    const project = db.insert(projects).values({ name: parsed.data.name, slug }).returning().get();

    // Every project starts with exactly one environment, and it is the default.
    db.insert(environments)
      .values({ projectId: project.id, name: 'Production', slug: 'production', isDefault: true })
      .run();

    return c.json({ project: serializeProject(project) }, 201);
  });

  app.get('/api/projects/:id', (c) => {
    const project = db
      .select()
      .from(projects)
      .where(eq(projects.id, c.req.param('id')))
      .get();
    if (!project) {
      const { status, body } = apiError('not_found', 'Project not found', 404);
      return c.json(body, status);
    }

    const envRows = db
      .select({
        id: environments.id,
        name: environments.name,
        slug: environments.slug,
        isDefault: environments.isDefault,
        serviceCount: count(serviceEnvs.id),
      })
      .from(environments)
      .leftJoin(serviceEnvs, eq(serviceEnvs.environmentId, environments.id))
      .where(eq(environments.projectId, project.id))
      .groupBy(environments.id)
      .orderBy(asc(environments.createdAt))
      .all();

    const serviceRows = db
      .select()
      .from(services)
      .where(eq(services.projectId, project.id))
      .orderBy(asc(services.createdAt))
      .all();

    const serviceIds = serviceRows.map((row) => row.id);
    const envLinks = serviceIds.length
      ? db.select().from(serviceEnvs).where(inArray(serviceEnvs.serviceId, serviceIds)).all()
      : [];

    const envLinkIds = envLinks.map((row) => row.id);
    const recentDeployments = envLinkIds.length
      ? db
          .select()
          .from(deployments)
          .where(inArray(deployments.serviceEnvId, envLinkIds))
          .orderBy(desc(deployments.createdAt))
          .all()
      : [];

    const latestByEnvLink = new Map<string, (typeof recentDeployments)[number]>();
    for (const deployment of recentDeployments) {
      if (!latestByEnvLink.has(deployment.serviceEnvId)) {
        latestByEnvLink.set(deployment.serviceEnvId, deployment);
      }
    }

    return c.json({
      project: serializeProject(project),
      environments: envRows,
      services: serviceRows.map((row) => ({
        id: row.id,
        name: row.name,
        slug: row.slug,
        repoFullName: row.repoFullName,
        dockerfilePath: row.dockerfilePath,
        contextPath: row.contextPath,
        containerPort: row.containerPort,
        memoryLimitMb: row.memoryLimitMb,
        serviceEnvs: envLinks
          .filter((link) => link.serviceId === row.id)
          .map((link) => {
            const latest = latestByEnvLink.get(link.id);
            return {
              id: link.id,
              environmentId: link.environmentId,
              branch: link.branch,
              healthPath: link.healthPath,
              generatedHost: link.generatedHost,
              customDomain: link.customDomain,
              latestDeployment: latest
                ? {
                    id: latest.id,
                    status: latest.status,
                    trigger: latest.trigger,
                    commitSha: latest.commitSha,
                    ciRunUrl: latest.ciRunUrl,
                    error: latest.error,
                    createdAt: iso(latest.createdAt),
                  }
                : null,
            };
          }),
      })),
    });
  });

  app.patch('/api/projects/:id', async (c) => {
    const parsed = patchProject.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      const { status, body } = validationError(parsed.error.issues);
      return c.json(body, status);
    }

    const updated = db
      .update(projects)
      .set({ name: parsed.data.name })
      .where(eq(projects.id, c.req.param('id')))
      .returning()
      .get();

    if (!updated) {
      const { status, body } = apiError('not_found', 'Project not found', 404);
      return c.json(body, status);
    }
    return c.json({ project: serializeProject(updated) });
  });

  app.delete('/api/projects/:id', async (c) => {
    const projectId = c.req.param('id');
    const existing = db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId))
      .get();
    if (!existing) {
      const { status, body } = apiError('not_found', 'Project not found', 404);
      return c.json(body, status);
    }

    const serviceEnvIds = serviceEnvIdsForProject(db, projectId);
    const names = containerNamesFor(db, serviceEnvIds);

    db.delete(projects).where(eq(projects.id, projectId)).run();

    // Routes first (a dead route is worse than a running container), then containers.
    await reconcileRoutes({ config, db, docker: deps.docker, admin: deps.admin });
    await stopContainers(deps.docker, names);

    return c.body(null, 204);
  });

  app.post('/api/projects/:id/environments', async (c) => {
    const project = db
      .select()
      .from(projects)
      .where(eq(projects.id, c.req.param('id')))
      .get();
    if (!project) {
      const { status, body } = apiError('not_found', 'Project not found', 404);
      return c.json(body, status);
    }

    const parsed = createEnvironment.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      const { status, body } = validationError(parsed.error.issues);
      return c.json(body, status);
    }

    const slug = uniqueValue(slugify(parsed.data.name, 'env'), (candidate) =>
      Boolean(
        db
          .select({ id: environments.id })
          .from(environments)
          .where(and(eq(environments.projectId, project.id), eq(environments.slug, candidate)))
          .get(),
      ),
    );

    const env = db
      .insert(environments)
      .values({ projectId: project.id, name: parsed.data.name, slug, isDefault: false })
      .returning()
      .get();

    return c.json({ environment: { ...env, createdAt: iso(env.createdAt) } }, 201);
  });

  app.patch('/api/environments/:id', async (c) => {
    const parsed = createEnvironment.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      const { status, body } = validationError(parsed.error.issues);
      return c.json(body, status);
    }

    // The slug is intentionally immutable: it is part of every generated host.
    const env = db
      .update(environments)
      .set({ name: parsed.data.name })
      .where(eq(environments.id, c.req.param('id')))
      .returning()
      .get();

    if (!env) {
      const { status, body } = apiError('not_found', 'Environment not found', 404);
      return c.json(body, status);
    }
    return c.json({ environment: { ...env, createdAt: iso(env.createdAt) } });
  });

  app.delete('/api/environments/:id', async (c) => {
    const env = db
      .select()
      .from(environments)
      .where(eq(environments.id, c.req.param('id')))
      .get();
    if (!env) {
      const { status, body } = apiError('not_found', 'Environment not found', 404);
      return c.json(body, status);
    }
    if (env.isDefault) {
      const { status, body } = apiError(
        'default_environment',
        'The default environment cannot be deleted',
        409,
      );
      return c.json(body, status);
    }

    const names = containerNamesFor(db, serviceEnvIdsForEnvironment(db, env.id));

    db.delete(environments).where(eq(environments.id, env.id)).run();

    await reconcileRoutes({ config, db, docker: deps.docker, admin: deps.admin });
    await stopContainers(deps.docker, names);

    return c.body(null, 204);
  });
}
