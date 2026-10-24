import { useEffect, useMemo, useState } from 'react';
import { LeftRail } from './components/LeftRail';
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
import { useRoute } from './lib/router';
import { useAsync } from './lib/useAsync';
import { CreateProjectPage } from './pages/CreateProjectPage';
import { DashboardPage } from './pages/DashboardPage';
import { LoginPage } from './pages/LoginPage';
import { NewServicePage } from './pages/NewServicePage';
import { ServicePage } from './pages/ServicePage';
import { VariablesPage } from './pages/VariablesPage';

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

  return (
    <div className="flex h-full flex-col">
      <TopBar
        project={overview.data?.project.name ?? 'no project'}
        environment={overview.data?.environments[0]?.name ?? 'Production'}
        ghcr={session.me.needsReconnect ? 'warn' : 'ok'}
        avatarUrl={session.me.avatarUrl}
        login={session.me.login}
        needsReconnect={session.me.needsReconnect}
        onSignOut={handleSignOut}
      />

      <div className="flex flex-1 overflow-hidden">
        <LeftRail
          projects={projectList}
          environments={overview.data?.environments ?? []}
          activeProjectId={activeProjectId}
          activeEnvId={overview.data?.environments[0]?.id ?? null}
          controlPlaneMb={rss}
        />

        {needsProject ? (
          <CreateProjectPage onCreated={projects.reload} />
        ) : (
          <>
            {route.name === 'dashboard' && activeProjectId ? (
              <DashboardPage
                projectId={activeProjectId}
                overview={overview.data}
                error={overview.error as ApiError | null}
                loading={overview.loading}
                reload={() => {
                  overview.reload();
                  projects.reload();
                }}
              />
            ) : null}

            {route.name === 'new-service' ? (
              <NewServicePage projectId={route.projectId ?? activeProjectId ?? ''} />
            ) : null}

            {route.name === 'service' ? <ServicePage serviceId={route.serviceId} /> : null}

            {route.name === 'variables' ? <VariablesPage serviceId={route.serviceId} /> : null}
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
