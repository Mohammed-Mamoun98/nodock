import { and, asc, eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { environments, serviceEnvs, services } from '../db/schema';
import { apiError, validationError } from '../http';
import {
  branch,
  containerPort,
  contextPath,
  dockerfileOutsideContext,
  dockerfilePath,
  healthPath,
  memoryLimitMb,
  repoFullName,
} from '../lib/build';
import { generatedHost, slugify, uniqueValue } from '../lib/slug';

const createService = z.object({
  name: z.string().trim().min(1).max(80),
  repoFullName,
  branch,
  dockerfilePath: dockerfilePath.optional(),
  contextPath: contextPath.optional(),
  containerPort: containerPort.optional(),
  environmentId: z.string().min(1).optional(),
});

const patchService = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  dockerfilePath: dockerfilePath.optional(),
  contextPath: contextPath.optional(),
  memoryLimitMb: memoryLimitMb.nullable().optional(),
});

const patchServiceEnv = z.object({
  branch: branch.optional(),
  healthPath: healthPath.nullable().optional(),
  containerPort: containerPort.nullable().optional(),
  customDomain: z.string().trim().toLowerCase().max(255).nullable().optional(),
});

export interface ServiceDeps {
  config: Config;
  db: Db;
}

const iso = (date: Date | null) => (date ? date.toISOString() : null);

export function serializeService(row: typeof services.$inferSelect) {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    slug: row.slug,
    repoFullName: row.repoFullName,
    dockerfilePath: row.dockerfilePath,
    contextPath: row.contextPath,
    containerPort: row.containerPort,
    memoryLimitMb: row.memoryLimitMb,
    createdAt: iso(row.createdAt),
  };
}

export function serializeServiceEnv(row: typeof serviceEnvs.$inferSelect) {
  return {
    id: row.id,
    serviceId: row.serviceId,
    environmentId: row.environmentId,
    branch: row.branch,
    healthPath: row.healthPath,
    generatedHost: row.generatedHost,
    customDomain: row.customDomain,
    createdAt: iso(row.createdAt),
  };
}

export function registerServiceRoutes(app: Hono, deps: ServiceDeps): void {
  const { db, config } = deps;

  app.post('/api/projects/:projectId/services', async (c) => {
    const parsed = createService.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      const { status, body } = validationError(parsed.error.issues);
      return c.json(body, status);
    }

    const input = parsed.data;
    const context = input.contextPath ?? '.';
    const dockerfile = input.dockerfilePath ?? 'Dockerfile';

    if (dockerfileOutsideContext(dockerfile, context)) {
      const { status, body } = apiError(
        'dockerfile_outside_context',
        `${dockerfile} is outside the build context ${context}`,
        422,
      );
      return c.json(body, status);
    }

    const environment = input.environmentId
      ? db.select().from(environments).where(eq(environments.id, input.environmentId)).get()
      : db
          .select()
          .from(environments)
          .where(
            and(
              eq(environments.projectId, c.req.param('projectId')),
              eq(environments.isDefault, true),
            ),
          )
          .get();

    if (!environment) {
      const { status, body } = apiError(
        'environment_not_found',
        'No such environment in this project',
        404,
      );
      return c.json(body, status);
    }

    const slug = uniqueValue(slugify(input.name, 'service'), (candidate) =>
      Boolean(
        db.select({ id: services.id }).from(services).where(eq(services.slug, candidate)).get(),
      ),
    );

    const service = db
      .insert(services)
      .values({
        projectId: c.req.param('projectId'),
        name: input.name,
        slug,
        repoFullName: input.repoFullName,
        dockerfilePath: dockerfile,
        contextPath: context,
        containerPort: input.containerPort ?? null,
      })
      .returning()
      .get();

    const host = uniqueValue(
      generatedHost(slug, environment.slug, config.baseDomain),
      (candidate) =>
        Boolean(
          db
            .select({ id: serviceEnvs.id })
            .from(serviceEnvs)
            .where(eq(serviceEnvs.generatedHost, candidate))
            .get(),
        ),
    );

    const serviceEnv = db
      .insert(serviceEnvs)
      .values({
        serviceId: service.id,
        environmentId: environment.id,
        branch: input.branch,
        generatedHost: host,
      })
      .returning()
      .get();

    return c.json(
      { service: serializeService(service), serviceEnv: serializeServiceEnv(serviceEnv) },
      201,
    );
  });

  app.get('/api/services/:id', (c) => {
    const service = db
      .select()
      .from(services)
      .where(eq(services.id, c.req.param('id')))
      .get();
    if (!service) {
      const { status, body } = apiError('not_found', 'Service not found', 404);
      return c.json(body, status);
    }

    const envs = db
      .select()
      .from(serviceEnvs)
      .where(eq(serviceEnvs.serviceId, service.id))
      .orderBy(asc(serviceEnvs.createdAt))
      .all();

    return c.json({
      service: serializeService(service),
      serviceEnvs: envs.map(serializeServiceEnv),
    });
  });

  app.patch('/api/services/:id', async (c) => {
    const parsed = patchService.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      const { status, body } = validationError(parsed.error.issues);
      return c.json(body, status);
    }

    const current = db
      .select()
      .from(services)
      .where(eq(services.id, c.req.param('id')))
      .get();
    if (!current) {
      const { status, body } = apiError('not_found', 'Service not found', 404);
      return c.json(body, status);
    }

    const dockerfile = parsed.data.dockerfilePath ?? current.dockerfilePath;
    const context = parsed.data.contextPath ?? current.contextPath;
    if (dockerfileOutsideContext(dockerfile, context)) {
      const { status, body } = apiError(
        'dockerfile_outside_context',
        `${dockerfile} is outside the build context ${context}`,
        422,
      );
      return c.json(body, status);
    }

    const updated = db
      .update(services)
      .set({
        ...(parsed.data.name === undefined ? {} : { name: parsed.data.name }),
        ...(parsed.data.dockerfilePath === undefined ? {} : { dockerfilePath: dockerfile }),
        ...(parsed.data.contextPath === undefined ? {} : { contextPath: context }),
        ...(parsed.data.memoryLimitMb === undefined
          ? {}
          : { memoryLimitMb: parsed.data.memoryLimitMb }),
      })
      .where(eq(services.id, current.id))
      .returning()
      .get();

    return c.json({ service: serializeService(updated) });
  });

  app.delete('/api/services/:id', (c) => {
    const deleted = db
      .delete(services)
      .where(eq(services.id, c.req.param('id')))
      .returning({ id: services.id })
      .get();

    if (!deleted) {
      const { status, body } = apiError('not_found', 'Service not found', 404);
      return c.json(body, status);
    }
    return c.body(null, 204);
  });

  app.get('/api/services/:id/envs/:envId', (c) => {
    const row = findServiceEnv(db, c.req.param('id'), c.req.param('envId'));
    if (!row) {
      const { status, body } = apiError('not_found', 'Service environment not found', 404);
      return c.json(body, status);
    }
    return c.json({ serviceEnv: serializeServiceEnv(row) });
  });

  app.patch('/api/services/:id/envs/:envId', async (c) => {
    const parsed = patchServiceEnv.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      const { status, body } = validationError(parsed.error.issues);
      return c.json(body, status);
    }

    const row = findServiceEnv(db, c.req.param('id'), c.req.param('envId'));
    if (!row) {
      const { status, body } = apiError('not_found', 'Service environment not found', 404);
      return c.json(body, status);
    }

    const updated = db
      .update(serviceEnvs)
      .set({
        ...(parsed.data.branch === undefined ? {} : { branch: parsed.data.branch }),
        ...(parsed.data.healthPath === undefined ? {} : { healthPath: parsed.data.healthPath }),
        ...(parsed.data.customDomain === undefined
          ? {}
          : { customDomain: parsed.data.customDomain }),
      })
      .where(eq(serviceEnvs.id, row.id))
      .returning()
      .get();

    if (parsed.data.containerPort !== undefined) {
      db.update(services)
        .set({ containerPort: parsed.data.containerPort })
        .where(eq(services.id, row.serviceId))
        .run();
    }

    return c.json({ serviceEnv: serializeServiceEnv(updated) });
  });
}

export function findServiceEnv(db: Db, serviceId: string, environmentId: string) {
  return db
    .select()
    .from(serviceEnvs)
    .where(and(eq(serviceEnvs.serviceId, serviceId), eq(serviceEnvs.environmentId, environmentId)))
    .get();
}
