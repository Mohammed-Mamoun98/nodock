import { useEffect, useMemo, useState } from 'react';
import { IconRail } from './components/IconRail';
import { TopBar } from './components/TopBar';
import { LinkButton } from './components/ui';
import {
  fetchControlPlaneRss,
  fetchMe,
  getProjectOverview,
  listProjects,
  signOut,
  type Me,
  type ProjectOverview,
  type ProjectSummary,
  type ApiError,
} from './lib/api';
import { navigate, useRoute } from './lib/router';
import { isDeploymentInFlight } from './lib/status';
import { useAsync } from './lib/useAsync';
import { CreateProjectPage } from './pages/CreateProjectPage';
import { DashboardPage } from './pages/DashboardPage';
import { LoginPage } from './pages/LoginPage';
import { NewServicePage } from './pages/NewServicePage';
import { ProjectSettingsPage } from './pages/ProjectSettingsPage';
import { ServicePanel } from './pages/ServicePanel';

type Session =
  | { status: 'loading' }
  | { status: 'anonymous' }
  | { status: 'authenticated'; me: Me };

async function handleSignOut(): Promise<void> {
  await signOut();
  window.location.reload();
}

export default function App() {
  const route = useRoute();
  const [session, setSession] = useState<Session>({ status: 'loading' });
  const [rss, setRss] = useState<number | null>(null);
  const [selectedEnvId, setSelectedEnvId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetchMe()
      .then((me) => {
        if (!cancelled) setSession(me ? { status: 'authenticated', me } : { status: 'anonymous' });
      })
      .catch(() => {
        if (!cancelled) setSession({ status: 'anonymous' });
      });

    fetchControlPlaneRss().then((value) => {
      if (!cancelled) setRss(value);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const authenticated = session.status === 'authenticated';

  const projects = useAsync(
    () => (authenticated ? listProjects() : Promise.resolve({ projects: [] as ProjectSummary[] })),
    [authenticated],
  );

  const requestedProjectId = route.name === 'dashboard' ? route.projectId : null;
  const projectList = useMemo(() => projects.data?.projects ?? [], [projects.data]);
  const activeProjectId = requestedProjectId ?? projectList[0]?.id ?? null;

  const overview = useAsync<ProjectOverview | null>(
    () => (activeProjectId ? getProjectOverview(activeProjectId) : Promise.resolve(null)),
    [activeProjectId],
    {
      pollMs: 4000,
      // Cards show the newest deployment state; refresh only while one is moving.
      shouldPoll: (page) =>
        page?.services.some((service) =>
          service.serviceEnvs.some((env) =>
            env.latestDeployment ? isDeploymentInFlight(env.latestDeployment.status) : false,
          ),
        ) ?? false,
      // Nothing in flight, but a card that says "live" can still turn into a crash.
      recheckMs: 15_000,
      recheckWhen: (page) =>
        page?.services.some((service) =>
          service.serviceEnvs.some((env) => env.latestDeployment?.status === 'live'),
        ) ?? false,
    },
  );

  if (session.status === 'loading') {
    return (
      <div className="flex h-full items-center justify-center bg-canvas">
        <span className="font-mono text-mono-xs text-text-dim">loading…</span>
      </div>
    );
  }

  if (session.status === 'anonymous') {
    return <LoginPage />;
  }

  const needsProject = !projects.loading && projectList.length === 0;
  const environmentList = overview.data?.environments ?? [];
  const activeEnvId =
    (selectedEnvId && environmentList.some((env) => env.id === selectedEnvId)
      ? selectedEnvId
      : null) ??
    environmentList.find((env) => env.isDefault)?.id ??
    environmentList[0]?.id ??
    null;
  const activePath =
    route.name === 'service' || route.name === 'dashboard'
      ? 'canvas'
      : route.name === 'new-service'
        ? 'new-service'
        : 'settings';

  return (
    <div className="flex h-full flex-col">
      <TopBar
        projects={projectList}
        activeProjectId={activeProjectId}
        onSelectProject={(id) => {
          setSelectedEnvId(null);
          navigate(`/?project=${id}`);
          projects.reload();
        }}
        environments={environmentList}
        activeEnvId={activeEnvId}
        onSelectEnvironment={setSelectedEnvId}
        ghcr={session.me.needsReconnect ? 'warn' : 'ok'}
        avatarUrl={session.me.avatarUrl}
        login={session.me.login}
        needsReconnect={session.me.needsReconnect}
        onSignOut={handleSignOut}
      />

      <div className="flex flex-1 overflow-hidden">
        <IconRail activePath={activePath} controlPlaneMb={rss} projectCount={projectList.length} />

        {needsProject ? (
          <CreateProjectPage onCreated={projects.reload} />
        ) : (
          <>
            {route.name === 'dashboard' || route.name === 'service' ? (
              <>
                {activeProjectId ? (
                  <DashboardPage
                    projectId={activeProjectId}
                    overview={overview.data}
                    error={overview.error as ApiError | null}
                    loading={overview.loading}
                    selectedServiceId={route.name === 'service' ? route.serviceId : null}
                    reload={() => {
                      overview.reload();
                      projects.reload();
                    }}
                  />
                ) : null}

                {/* The service is a side panel, like Railway: the canvas stays visible. */}
                {route.name === 'service' ? (
                  <ServicePanel
                    serviceId={route.serviceId}
                    activeEnvId={activeEnvId}
                    onClose={() => {
                      window.location.hash = '/';
                      overview.reload();
                    }}
                  />
                ) : null}
              </>
            ) : null}

            {route.name === 'project-settings' && activeProjectId ? (
              <ProjectSettingsPage
                projectId={activeProjectId}
                overview={overview.data}
                onChanged={() => {
                  projects.reload();
                  overview.reload();
                }}
              />
            ) : null}

            {route.name === 'new-service' ? (
              <NewServicePage projectId={route.projectId ?? activeProjectId ?? ''} />
            ) : null}

            {route.name === 'variables' ? (
              <ServicePanel
                serviceId={route.serviceId}
                activeEnvId={activeEnvId}
                onClose={() => navigate('/')}
              />
            ) : null}
          </>
        )}

        {route.name === 'not-found' ? (
          <main className="flex flex-1 items-center justify-center p-8">
            <div className="rounded-lg border border-line bg-surface p-8 text-center">
              <h1 className="mb-2 text-ui-lg font-medium">No route for {route.path}</h1>
              <LinkButton to="#/">Back to project</LinkButton>
            </div>
          </main>
        ) : null}
      </div>
    </div>
  );
}
