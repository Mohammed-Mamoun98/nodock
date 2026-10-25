import { describe, expect, test } from 'bun:test';
import { createApp } from '../src/app';
import type { GitHubClient } from '../src/auth/github';
import { loadConfig } from '../src/config';
import type { DockerAdapter } from '../src/docker/adapter';
import { deployments, environments, projects, serviceEnvs, services } from '../src/db/schema';
import { runtimeStateOf, runtimeWarning, sweepRuntime } from '../src/deploy/runtime';
import { signIn, testDb } from './helpers';

const config = loadConfig({
  NODOCK_SECRET: 'x'.repeat(32),
  NODOCK_URL: 'https://panel.example.com',
  BASE_DOMAIN: 'apps.example.com',
  DATA_DIR: '/tmp/nodock-runtime-test',
  ADMIN_GITHUB_LOGIN: 'mohammed',
  GITHUB_CLIENT_ID: 'client-id',
  GITHUB_CLIENT_SECRET: 'client-secret',
});

const github: GitHubClient = {
  authorizeUrl: () => 'https://github.com/login/oauth/authorize',
  exchangeCode: async () => ({ accessToken: 'x', scopes: ['repo', 'workflow'] }),
  getUser: async () => ({ id: 1, login: 'mohammed', avatarUrl: null }),
  listRepos: async () => ({ repos: [], hasMore: false }),
  listBranches: async () => [],
};

type Db = ReturnType<typeof testDb>['db'];

function seed(db: Db) {
  const project = db.insert(projects).values({ name: 'Milo', slug: 'milo' }).returning().get();
  const env = db
    .insert(environments)
    .values({ projectId: project.id, name: 'Production', slug: 'production', isDefault: true })
    .returning()
    .get();
  const service = db
    .insert(services)
    .values({ projectId: project.id, name: 'api', slug: 'api', repoFullName: 'mohammed/milo' })
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

  return { service, serviceEnv };
}

function addDeployment(db: Db, serviceEnvId: string, status: 'live' | 'failed' | 'superseded') {
  return db
    .insert(deployments)
    .values({
      serviceEnvId,
      trigger: 'push',
      status,
      imageRef: 'ghcr.io/mohammed/milo:abc',
      containerName: `nodock-api-prod-${status}`,
    })
    .returning()
    .get();
}

/** Records every name it was asked about; `answers` maps a container name to a reply. */
function dockerStub(answers: Record<string, unknown>) {
  const inspected: string[] = [];
  const docker: Pick<DockerAdapter, 'inspect'> = {
    async inspect(name) {
      inspected.push(name);
      const answer = answers[name];
      if (answer instanceof Error) throw answer;
      if (answer === undefined) return null;
      return answer as Awaited<ReturnType<DockerAdapter['inspect']>>;
    },
  };
  return { docker, inspected };
}

describe('runtime sweep', () => {
  test('records what the daemon says about the live container', async () => {
    const { db } = testDb();
    const { serviceEnv } = seed(db);
    const row = addDeployment(db, serviceEnv.id, 'live');

    const { docker, inspected } = dockerStub({
      'nodock-api-prod-live': {
        running: true,
        exitCode: 0,
        status: 'running',
        restartCount: 0,
        oomKilled: false,
      },
    });

    const result = await sweepRuntime(db, docker, Date.parse('2026-10-25T10:00:00.000Z'));

    expect(inspected).toEqual(['nodock-api-prod-live']);
    expect(result.checked).toBe(1);
    expect(result.unreachable).toBe(false);

    const after = db.select().from(deployments).all()[0]!;
    expect(after.id).toBe(row.id);
    expect(after.runtimeState).toBe('running');
    expect(after.runtimeRestarts).toBe(0);
    expect(after.runtimeOom).toBe(false);
    expect(after.runtimeCheckedAt?.toISOString()).toBe('2026-10-25T10:00:00.000Z');
    // A healthy container has nothing to say: the panel keeps its green "live".
    expect(runtimeWarning(after)).toBeNull();
  });

  test('a crash loop is not a live deployment, even though the deploy worked', async () => {
    const { db } = testDb();
    const { serviceEnv } = seed(db);
    addDeployment(db, serviceEnv.id, 'live');

    const { docker } = dockerStub({
      'nodock-api-prod-live': {
        running: true,
        exitCode: 1,
        status: 'restarting',
        restartCount: 7,
      },
    });

    const result = await sweepRuntime(db, docker);
    expect(result.changed.map((change) => change.to)).toEqual(['restarting']);

    const after = db.select().from(deployments).all()[0]!;
    expect(after.status).toBe('live');
    expect(after.runtimeState).toBe('restarting');
    expect(runtimeWarning(after)).toContain('keeps restarting (7 restarts)');
  });

  test('an exited container is reported with its code, and OOM is named', async () => {
    const { db } = testDb();
    const { serviceEnv } = seed(db);
    addDeployment(db, serviceEnv.id, 'live');

    const { docker } = dockerStub({
      'nodock-api-prod-live': {
        running: false,
        exitCode: 137,
        status: 'exited',
        restartCount: 2,
        oomKilled: true,
      },
    });

    await sweepRuntime(db, docker);
    const after = db.select().from(deployments).all()[0]!;

    expect(after.runtimeState).toBe('exited');
    expect(after.runtimeExitCode).toBe(137);
    expect(after.runtimeOom).toBe(true);
    expect(runtimeWarning(after)).toBe('container killed by the OOM killer, exit 137');
  });

  test('a container that is not there is missing, not a failed deploy', async () => {
    const { db } = testDb();
    const { serviceEnv } = seed(db);
    addDeployment(db, serviceEnv.id, 'live');

    // inspect resolves null for "no such container".
    const { docker } = dockerStub({});
    await sweepRuntime(db, docker);

    const after = db.select().from(deployments).all()[0]!;
    expect(after.runtimeState).toBe('missing');
    expect(after.status).toBe('live');
    expect(runtimeWarning(after)).toContain('container is gone');
  });

  test('an unreachable daemon says unknown rather than inventing an outage', async () => {
    const { db } = testDb();
    const { serviceEnv } = seed(db);
    addDeployment(db, serviceEnv.id, 'live');

    const { docker } = dockerStub({
      'nodock-api-prod-live': new Error('Cannot connect to the Docker daemon'),
    });

    const result = await sweepRuntime(db, docker);

    expect(result.unreachable).toBe(true);
    expect(result.checked).toBe(0);
    for (const row of db.select().from(deployments).all()) {
      expect(row.runtimeState).toBe('unknown');
      expect(row.runtimeExitCode).toBeNull();
    }
  });

  test('only live deployments are inspected — history is not polled forever', async () => {
    const { db } = testDb();
    const { serviceEnv } = seed(db);
    addDeployment(db, serviceEnv.id, 'live');
    addDeployment(db, serviceEnv.id, 'superseded');
    addDeployment(db, serviceEnv.id, 'failed');

    const { docker, inspected } = dockerStub({});
    await sweepRuntime(db, docker);

    expect(inspected).toEqual(['nodock-api-prod-live']);
  });

  test('unrecognised daemon states are not trusted', () => {
    expect(runtimeStateOf(null)).toBe('missing');
    expect(runtimeStateOf({ running: true, exitCode: 0, status: 'paused' })).toBe('paused');
    expect(runtimeStateOf({ running: true, exitCode: 0, status: 'frozen' })).toBe('unknown');
  });
});

describe('runtime fields over http', () => {
  test('a crashed container reaches the panel with the sentence to show', async () => {
    const { db } = testDb();
    const { service, serviceEnv } = seed(db);
    addDeployment(db, serviceEnv.id, 'live');
    db.update(deployments)
      .set({ runtimeState: 'exited', runtimeExitCode: 1, runtimeRestarts: 3, runtimeOom: false })
      .run();

    const app = createApp({ config, db, admin: null, github });
    const call = await signIn(app);
    const body = (await (await call(`/api/services/${service.id}/deployments`)).json()) as {
      deployments: {
        status: string;
        runtimeState: string | null;
        runtimeWarning: string | null;
        runtimeExitCode: number | null;
      }[];
    };

    expect(body.deployments[0]!.status).toBe('live');
    expect(body.deployments[0]!.runtimeState).toBe('exited');
    expect(body.deployments[0]!.runtimeExitCode).toBe(1);
    expect(body.deployments[0]!.runtimeWarning).toBe('container exited with code 1 (3 restarts)');
  });
});
