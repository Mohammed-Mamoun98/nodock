import { useEffect, useState } from 'react';
import { LeftRail } from './components/LeftRail';
import { TopBar } from './components/TopBar';
import { LinkButton } from './components/ui';
import { environments, projects, services } from './lib/fixtures';
import { useRoute } from './lib/router';
import { DashboardPage } from './pages/DashboardPage';
import { NewServicePage } from './pages/NewServicePage';
import { ServicePage } from './pages/ServicePage';
import { VariablesPage } from './pages/VariablesPage';

/** Real number from the running control plane — the rail proves the product's own thesis. */
function useControlPlaneRss(): number | null {
  const [rss, setRss] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/metrics-lite')
      .then((response) => (response.ok ? (response.json() as Promise<{ rssMb: number }>) : null))
      .then((data) => {
        if (!cancelled && data) setRss(data.rssMb);
      })
      .catch(() => {
        /* metrics are a nicety; the panel works without them */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return rss;
}

export default function App() {
  const route = useRoute();
  const rss = useControlPlaneRss();

  return (
    <div className="flex h-full flex-col">
      <TopBar
        project="milo"
        environment="Production"
        ghcr="ok"
        avatarUrl="https://i.pravatar.cc/64?u=mohammed"
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
