import { useState } from 'react';
import { navigate } from '../lib/router';
import { Icon } from '../components/Icon';
import { ServiceCard } from '../components/ServiceCard';
import { Button, LinkButton } from '../components/ui';
import { ApiError, deleteProject, type ProjectOverview } from '../lib/api';
import { toServiceView, type ServiceState } from '../lib/view';

type Filter = 'all' | ServiceState;

const filters: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'live', label: 'Live' },
  { id: 'building', label: 'Building' },
  { id: 'failed', label: 'Failed' },
  { id: 'stopped', label: 'Stopped' },
  { id: 'undeployed', label: 'Not deployed' },
];

interface DashboardPageProps {
  projectId: string;
  overview: ProjectOverview | null;
  error: ApiError | null;
  loading: boolean;
  /** Service currently open in the side panel, highlighted on the canvas. */
  selectedServiceId?: string | null;
  reload: () => void;
  onDeleted: () => void;
}

export function DashboardPage({
  projectId,
  overview,
  error,
  loading,
  selectedServiceId = null,
  reload,
  onDeleted,
}: DashboardPageProps) {
  const [filter, setFilter] = useState<Filter>('all');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const services = (overview?.services ?? []).map(toServiceView);
  const counts: Record<Filter, number> = {
    all: services.length,
    live: services.filter((s) => s.state === 'live').length,
    building: services.filter((s) => s.state === 'building').length,
    failed: services.filter((s) => s.state === 'failed').length,
    stopped: services.filter((s) => s.state === 'stopped').length,
    undeployed: services.filter((s) => s.state === 'undeployed').length,
  };
  const visible = filter === 'all' ? services : services.filter((s) => s.state === filter);
  const selectedId =
    selectedServiceId ?? services.find((s) => s.state === 'building')?.id ?? services[0]?.id;

  return (
    <main className="relative flex flex-1 flex-col overflow-y-auto bg-canvas dot-grid">
      <div className="sticky top-0 z-20 flex h-14 items-center justify-between border-b border-line bg-surface px-6">
        <nav className="flex h-full items-center gap-4" aria-label="Filter services">
          {filters.map((f) => {
            const active = filter === f.id;
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => setFilter(f.id)}
                aria-current={active ? 'true' : undefined}
                className={`flex h-full items-center gap-1.5 border-b-2 px-2 text-ui-sm transition-colors ${
                  active
                    ? 'border-lime text-text'
                    : 'border-transparent text-text-dim hover:text-text'
                }`}
              >
                {f.label}
                <span className={`font-mono text-mono-xs ${active ? 'text-text-dim' : ''}`}>
                  {counts[f.id]}
                </span>
              </button>
            );
          })}
        </nav>

        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={reload}
            className="hidden font-mono text-mono-xs text-text-dim transition-colors hover:text-text sm:inline"
          >
            refresh
          </button>
          <LinkButton
            to={`#/services/new?project=${projectId}`}
            variant="secondary"
            className="border-lime text-lime hover:bg-lime/10"
          >
            <Icon name="plus" />
            New service
          </LinkButton>
          <button
            type="button"
            onClick={() => {
              setConfirmOpen(true);
              setConfirmText('');
              setDeleteError(null);
            }}
            className="font-mono text-mono-xs text-text-dim transition-colors hover:text-red"
          >
            delete project
          </button>
        </div>
      </div>

      {confirmOpen ? (
        <div className="border-b border-red/30 bg-red/5 px-6 py-3">
          <div className="mx-auto flex w-full max-w-[600px] flex-col gap-2">
            <p className="text-ui-sm">
              Delete{' '}
              <span className="font-mono text-text">{overview?.project.name ?? projectId}</span>?
              Every service, deployment and variable in it is removed, and its containers are
              stopped. This cannot be undone.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={confirmText}
                onChange={(event) => setConfirmText(event.target.value)}
                placeholder={`type the project name to confirm`}
                aria-label="Type the project name to confirm deletion"
                className="h-7 w-[260px] rounded border border-line bg-surface-2 px-2 font-mono text-mono-xs"
              />
              <Button
                variant="primary"
                className="border-red bg-red text-canvas hover:bg-red/90"
                disabled={deleting || confirmText.trim() !== (overview?.project.name ?? projectId)}
                onClick={async () => {
                  setDeleting(true);
                  setDeleteError(null);
                  try {
                    await deleteProject(projectId);
                    onDeleted();
                    navigate('/');
                  } catch (cause) {
                    setDeleteError(
                      cause instanceof ApiError
                        ? `${cause.code} · ${cause.message}`
                        : String(cause),
                    );
                    setDeleting(false);
                  }
                }}
              >
                {deleting ? 'Deleting…' : 'Delete project'}
              </Button>
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                className="text-ui-sm text-text-dim hover:text-text"
              >
                Cancel
              </button>
              {deleteError ? (
                <span className="font-mono text-mono-xs text-red">{deleteError}</span>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

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
              <h3 className="mb-2 font-sans text-ui-lg text-text">
                {services.length === 0 ? 'No services yet' : `No ${filter} services`}
              </h3>
              <p className="mb-6 font-sans text-ui-sm text-text-dim">
                {services.length === 0
                  ? 'Connect a repository that has a Dockerfile to deploy your first service.'
                  : 'Nothing matches this filter right now.'}
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
