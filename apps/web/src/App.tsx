import { useEffect, useState } from 'react';
import { LeftRail } from './components/LeftRail';
import { TopBar } from './components/TopBar';
import { LinkButton } from './components/ui';
import { fetchControlPlaneRss, fetchMe, signOut, type Me } from './lib/api';
import { environments, projects } from './lib/fixtures';
import { useRoute } from './lib/router';
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
        if (cancelled) return;
        setSession(me ? { status: 'authenticated', me } : { status: 'anonymous' });
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

  const me = session.me;

  return (
    <div className="flex h-full flex-col">
      <TopBar
        project="milo"
        environment="Production"
        ghcr="ok"
        avatarUrl={me.avatarUrl}
        login={me.login}
        needsReconnect={me.needsReconnect}
        onSignOut={handleSignOut}
      />

      <div className="flex flex-1 overflow-hidden">
        <LeftRail
          projects={projects}
          environments={environments}
          activeProject="milo"
          controlPlaneMb={rss}
          deploysToday={1}
        />

        {route.name === 'dashboard' ? <DashboardPage /> : null}
        {route.name === 'new-service' ? <NewServicePage /> : null}
        {route.name === 'service' ? <ServicePage serviceId={route.serviceId} /> : null}
        {route.name === 'variables' ? <VariablesPage serviceId={route.serviceId} /> : null}

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
