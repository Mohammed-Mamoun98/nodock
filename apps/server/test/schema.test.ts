import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { deployments, environments, projects, serviceEnvs, services, variables } from '../src/db/schema';
import { testDb } from './helpers';

function seed() {
  const { db } = testDb();
  const project = db
    .insert(projects)
    .values({ name: 'Shop', slug: 'shop' })
    .returning()
    .get();
  const env = db
    .insert(environments)
    .values({ projectId: project.id, name: 'Production', slug: 'production', isDefault: true })
    .returning()
    .get();
  const service = db
    .insert(services)
    .values({ projectId: project.id, name: 'API', slug: 'api', repoFullName: 'alice/shop' })
    .returning()
    .get();
  const serviceEnv = db
    .insert(serviceEnvs)
    .values({
      serviceId: service.id,
      environmentId: env.id,
      branch: 'main',
      generatedHost: 'api.apps.example.com',
    })
    .returning()
    .get();
  return { db, project, env, service, serviceEnv };
}

describe('schema', () => {
  test('applies documented defaults', () => {
    const { service } = seed();
    expect(service.dockerfilePath).toBe('Dockerfile');
    expect(service.contextPath).toBe('.');
    expect(service.containerPort).toBeNull();
    expect(service.createdAt).toBeInstanceOf(Date);
  });

  test('deployment defaults to queued and stores an immutable digest', () => {
    const { db, serviceEnv } = seed();
    const deployment = db
      .insert(deployments)
      .values({
        serviceEnvId: serviceEnv.id,
        trigger: 'push',
        imageRef: 'ghcr.io/alice/shop:api-abc123',
        imageDigest: 'sha256:deadbeef',
      })
      .returning()
      .get();

    expect(deployment.status).toBe('queued');
    expect(deployment.imageDigest).toBe('sha256:deadbeef');
    expect(deployment.finishedAt).toBeNull();
  });

  test('rejects a duplicate variable key in one environment', () => {
    const { db, serviceEnv } = seed();
    db.insert(variables).values({ serviceEnvId: serviceEnv.id, key: 'TOKEN', valueEnc: 'v1' }).run();

    expect(() =>
      db.insert(variables).values({ serviceEnvId: serviceEnv.id, key: 'TOKEN', valueEnc: 'v2' }).run(),
    ).toThrow();
  });

  test('cascades deletes from project down to deployments', () => {
    const { db, project, serviceEnv } = seed();
    db.insert(deployments).values({ serviceEnvId: serviceEnv.id, trigger: 'manual', imageRef: 'x:1' }).run();

    db.delete(projects).where(eq(projects.id, project.id)).run();

    expect(db.select().from(services).all()).toHaveLength(0);
    expect(db.select().from(serviceEnvs).all()).toHaveLength(0);
    expect(db.select().from(deployments).all()).toHaveLength(0);
  });

  test('generated hosts are unique across all services', () => {
    const { db, env, service } = seed();
    const other = db
      .insert(services)
      .values({ projectId: service.projectId, name: 'Web', slug: 'web', repoFullName: 'alice/shop' })
      .returning()
      .get();

    expect(() =>
      db
        .insert(serviceEnvs)
        .values({
          serviceId: other.id,
          environmentId: env.id,
          branch: 'main',
          generatedHost: 'api.apps.example.com',
        })
        .run(),
    ).toThrow();
  });
});
