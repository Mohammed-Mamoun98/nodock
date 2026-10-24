import { Icon } from '../components/Icon';
import { ServiceCard } from '../components/ServiceCard';
import { LinkButton } from '../components/ui';
import type { ApiError, ProjectOverview } from '../lib/api';
import { toServiceView } from '../lib/view';

interface DashboardPageProps {
  projectId: string;
  overview: ProjectOverview | null;
  error: ApiError | null;
  loading: boolean;
  /** Service currently open in the side panel, highlighted on the canvas. */
  selectedServiceId?: string | null;
  reload: () => void;
}

export function DashboardPage({
  projectId,
  overview,
  error,
  loading,
  selectedServiceId = null,
  reload,
}: DashboardPageProps) {
  const services = (overview?.services ?? []).map(toServiceView);
  const visible = services;
  const selectedId =
    selectedServiceId ?? services.find((s) => s.state === 'building')?.id ?? services[0]?.id;

  return (
    <main className="relative flex flex-1 flex-col overflow-y-auto bg-canvas dot-grid">
      <div className="sticky top-0 z-20 flex h-12 items-center justify-between border-b border-line bg-surface px-6">
        <span className="font-mono text-mono-xs text-text-dim">
          {overview?.project.name ?? 'project'}
          <span className="opacity-50"> · </span>
          {services.length} service{services.length === 1 ? '' : 's'}
        </span>

        <div className="flex items-center gap-2">
          <LinkButton
            to={`#/services/new?project=${projectId}`}
            variant="secondary"
            className="border-lime text-lime hover:bg-lime/10"
          >
            <Icon name="plus" />
            New service
          </LinkButton>
        </div>
      </div>

      <div className="relative flex flex-1 flex-col p-8">
        {loading && !overview ? (
          <p className="mx-auto font-mono text-mono-xs text-text-dim">loading services…</p>
        ) : null}

        {error ? (
          <div className="mx-auto flex w-[420px] flex-col gap-3 rounded-lg border border-red/30 bg-surface p-6">
            <h2 className="text-ui-base font-medium text-red">Could not load this project</h2>
            <p className="font-mono text-mono-xs text-text-dim">
              {error.code} · {error.message}
            </p>
            <button
              type="button"
              onClick={reload}
              className="self-start rounded border border-line px-3 py-1 text-ui-sm hover:bg-surface-2"
            >
              Retry
            </button>
          </div>
        ) : null}

        {!error && !loading && visible.length === 0 ? (
          <div className="flex flex-1 items-center justify-center">
            <div className="flex w-[400px] flex-col items-center rounded-lg border border-dashed border-line bg-surface/50 p-8 text-center">
              <h3 className="mb-2 font-sans text-ui-lg text-text">No services yet</h3>
              <p className="mb-6 font-sans text-ui-sm text-text-dim">
                Connect a repository that has a Dockerfile to deploy your first service.
              </p>
              <LinkButton
                to={`#/services/new?project=${projectId}`}
                variant="primary"
                className="border-0 px-4"
              >
                <Icon name="plus" />
                New service
              </LinkButton>
            </div>
          </div>
        ) : null}

        {services.length > 0 ? (
          <>
            <div className="mx-auto grid w-full max-w-[600px] grid-cols-1 justify-items-center gap-x-12 gap-y-8 lg:grid-cols-2">
              {visible.map((service) => (
                <ServiceCard
                  key={service.id}
                  service={service}
                  selected={service.id === selectedId}
                />
              ))}
              {visible.length % 2 === 1 ? <div className="hidden lg:block" aria-hidden /> : null}
            </div>

            <div className="mx-auto mt-auto flex w-full max-w-[600px] items-center justify-center pt-10 pb-2">
              <span className="flex items-center gap-2 rounded border border-line bg-surface px-3 py-1.5">
                <span className="h-2 w-2 rounded-full bg-lime" aria-hidden />
                <span className="font-mono text-mono-xs text-text-dim">caddy · :443</span>
              </span>
            </div>
          </>
        ) : null}
      </div>
    </main>
  );
}
