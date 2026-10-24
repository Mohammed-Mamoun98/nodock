import { useMemo, useState } from 'react';
import { Icon } from '../components/Icon';
import { Button, StatusChip, StatusWord } from '../components/ui';
import {
  ApiError,
  deleteService,
  deployService,
  getService,
  listDeployments,
  type DeploymentRow,
} from '../lib/api';
import { deploymentStatusMeta, isDeploymentInFlight, stateMeta } from '../lib/status';
import { useAsync } from '../lib/useAsync';
import { deriveState, relativeAge } from '../lib/view';
import { navigate } from '../lib/router';
import { VariablesPanel } from './VariablesPanel';

const tabs = ['Deployments', 'Variables', 'Settings'] as const;
type Tab = (typeof tabs)[number];

function duration(start: string | null, end: string | null): string {
  if (!start) return '—';
  const ms = (end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime();
  const seconds = Math.max(1, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function triggerLabel(row: DeploymentRow): string {
  return row.trigger === 'push'
    ? 'via GitHub'
    : row.trigger === 'rollback'
      ? 'via rollback'
      : 'via deploy';
}

/** One deployment card, Railway-style: subject line, provenance, and a status footer. */
function DeploymentCard({
  row,
  active,
  onOpenRun,
  busy,
  onRollback,
}: {
  row: DeploymentRow;
  active: boolean;
  onOpenRun: (url: string) => void;
  busy: boolean;
  onRollback?: () => void;
}) {
  const chip = deploymentStatusMeta[row.status];
  const inFlight = isDeploymentInFlight(row.status);
  const skipped = row.status === 'cancelled';

  return (
    <div
      className={`rounded-md border bg-surface ${
        active ? 'border-lime/40' : 'border-line hover:border-line-strong'
      } transition-colors`}
    >
      <div className="flex items-start justify-between gap-3 p-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center gap-2">
            <StatusChip label={active ? 'active' : chip.label} tone={active ? 'lime' : chip.tone} />
            <span className="truncate text-ui-sm text-text">
              {row.commitMessage ?? row.imageRef.split(':').pop() ?? 'deployment'}
            </span>
          </div>
          <span className="font-mono text-mono-xs text-text-dim">
            {row.commitSha?.slice(0, 7) ?? '—'} · {relativeAge(row.createdAt)} {triggerLabel(row)} ·{' '}
            {duration(row.startedAt, row.finishedAt)}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {row.ciRunUrl ? (
            <button
              type="button"
              onClick={() => onOpenRun(row.ciRunUrl ?? '')}
              className="rounded border border-line px-2 py-1 text-ui-sm text-text-dim transition-colors hover:bg-surface-2 hover:text-text"
            >
              View logs
            </button>
          ) : null}
          {onRollback && !inFlight && !skipped ? (
            <button
              type="button"
              onClick={onRollback}
              disabled={busy}
              className="rounded border border-line px-2 py-1 text-ui-sm text-text-dim transition-colors hover:bg-surface-2 hover:text-text disabled:opacity-40"
            >
              Rollback
            </button>
          ) : null}
        </div>
      </div>

      <div
        className={`flex items-center gap-2 rounded-b-md border-t px-3 py-1.5 font-mono text-mono-xs ${
          row.status === 'failed'
            ? 'border-red/20 bg-red/5 text-red'
            : skipped
              ? 'border-line bg-surface-2/30 text-text-dim'
              : 'border-line bg-surface-2/30 text-text-dim'
        }`}
      >
        <Icon
          name={row.status === 'failed' ? 'alert-triangle' : skipped ? 'pause' : 'check'}
          className="h-3 w-3"
        />
        <span className="truncate">
          {row.status === 'failed'
            ? (row.error ?? 'deployment failed')
            : skipped
              ? (row.error ?? 'superseded by a newer deployment')
              : inFlight
                ? `${chip.label}…`
                : 'Deployment successful'}
        </span>
      </div>
    </div>
  );
}

export function ServicePanel({ serviceId, onClose }: { serviceId: string; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('Deployments');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [hideSkipped, setHideSkipped] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState('');
  const [deleting, setDeleting] = useState(false);

  const service = useAsync(() => getService(serviceId), [serviceId]);
  const deployments = useAsync(() => listDeployments(serviceId), [serviceId], {
    pollMs: 3000,
    shouldPoll: (page) => isDeploymentInFlight(page?.deployments[0]?.status ?? ''),
  });

  const rows = useMemo(() => deployments.data?.deployments ?? [], [deployments.data]);
  const activeRow = rows.find((row) => row.status === 'live') ?? rows[0] ?? null;
  const history = rows.filter((row) => row.id !== activeRow?.id);

  const link = service.data?.serviceEnvs[0] ?? null;
  const host = link?.customDomain ?? link?.generatedHost ?? '';
  const state = deriveState(
    activeRow
      ? {
          id: activeRow.id,
          status: activeRow.status,
          trigger: activeRow.trigger,
          commitSha: activeRow.commitSha,
          ciRunUrl: activeRow.ciRunUrl,
          error: activeRow.error,
          createdAt: activeRow.createdAt,
        }
      : null,
  );
  const meta = stateMeta[state];

  async function runDeploy() {
    if (!link) return;
    setBusy(true);
    setActionError(null);
    try {
      await deployService(serviceId, link.environmentId);
      deployments.reload();
    } catch (cause) {
      setActionError(
        cause instanceof ApiError ? `${cause.code} · ${cause.message}` : String(cause),
      );
    } finally {
      setBusy(false);
    }
  }

  async function removeService() {
    setDeleting(true);
    setActionError(null);
    try {
      await deleteService(serviceId);
      onClose();
    } catch (cause) {
      setActionError(
        cause instanceof ApiError ? `${cause.code} · ${cause.message}` : String(cause),
      );
      setDeleting(false);
    }
  }

  if (service.loading && !service.data) {
    return (
      <aside className="flex w-[520px] shrink-0 items-center justify-center border-l border-line bg-surface">
        <span className="font-mono text-mono-xs text-text-dim">loading service…</span>
      </aside>
    );
  }

  if (service.error || !service.data) {
    return (
      <aside className="flex w-[520px] shrink-0 flex-col items-center justify-center gap-3 border-l border-line bg-surface p-8">
        <h2 className="text-ui-lg font-medium">
          {service.error?.status === 404
            ? `No service called ${serviceId}`
            : 'Could not load service'}
        </h2>
        <p className="font-mono text-mono-xs text-text-dim">{service.error?.message}</p>
        <Button onClick={onClose}>Close</Button>
      </aside>
    );
  }

  const record = service.data.service;

  return (
    <aside className="flex w-[520px] shrink-0 flex-col overflow-hidden border-l border-line bg-surface">
      <div className="flex items-start justify-between gap-3 px-5 pt-5">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center gap-2">
            <Icon name="github" className="h-4 w-4 text-text-dim" />
            <h2 className="truncate text-ui-lg font-semibold">{record.name}</h2>
          </div>
          <div className="flex items-center gap-2">
            <StatusWord label={meta.label} tone={meta.tone} inFlight={meta.inFlight} />
            <span className="font-mono text-mono-xs text-text-dim">
              {record.repoFullName}@{link?.branch ?? '—'}
            </span>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Button variant="primary" onClick={runDeploy} disabled={busy || !link}>
            {busy ? 'Starting…' : 'Deploy'}
          </Button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close service panel"
            className="p-1 text-text-dim transition-colors hover:text-text"
          >
            <Icon name="x" />
          </button>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-5 border-b border-line px-5">
        {tabs.map((entry) => (
          <button
            key={entry}
            type="button"
            onClick={() => setTab(entry)}
            aria-current={tab === entry ? 'page' : undefined}
            className={`-mb-px border-b-2 pb-2 text-ui-sm transition-colors ${
              tab === entry
                ? 'border-lime font-medium text-text'
                : 'border-transparent text-text-dim hover:text-text'
            }`}
          >
            {entry}
          </button>
        ))}
      </div>

      {actionError ? (
        <p className="mx-5 mt-3 rounded border border-red/30 bg-red/10 px-2 py-1.5 font-mono text-mono-xs text-red">
          {actionError}
        </p>
      ) : null}

      {tab === 'Deployments' ? (
        <div className="flex flex-1 flex-col overflow-y-auto">
          <div className="flex items-center justify-between border-b border-line px-5 py-2">
            <span className="flex min-w-0 items-center gap-1.5 font-mono text-mono-xs text-text-dim">
              <Icon name="globe" className="h-3 w-3" />
              <span className="truncate text-text">{host || 'no host'}</span>
            </span>
            <span className="shrink-0 font-mono text-mono-xs text-text-dim">
              {record.memoryLimitMb ?? 512} MB · 1 replica
            </span>
          </div>

          <div className="flex flex-col gap-3 p-4">
            {deployments.loading && rows.length === 0 ? (
              <p className="font-mono text-mono-xs text-text-dim">loading deployments…</p>
            ) : null}

            {!deployments.loading && rows.length === 0 ? (
              <div className="rounded-md border border-dashed border-line p-6 text-center">
                <h3 className="mb-1.5 text-ui-base font-medium">No deployments yet</h3>
                <p className="text-ui-sm text-text-dim">
                  Press Deploy — GitHub Actions builds the image and nodock runs it.
                </p>
              </div>
            ) : null}

            {activeRow ? (
              <DeploymentCard
                row={activeRow}
                active={activeRow.status === 'live'}
                busy={busy}
                onOpenRun={(url) => window.open(url, '_blank', 'noreferrer')}
              />
            ) : null}

            {history.length > 0 ? (
              <>
                <div className="flex items-center justify-between pt-2">
                  <h3 className="font-mono text-[10px] uppercase tracking-wide text-text-dim">
                    history
                  </h3>
                  <button
                    type="button"
                    onClick={() => setHideSkipped((value) => !value)}
                    className="font-mono text-mono-xs text-text-dim hover:text-text"
                  >
                    {hideSkipped ? 'Show skipped' : 'Hide skipped'}
                  </button>
                </div>

                {history
                  .filter((row) => (hideSkipped ? row.status !== 'cancelled' : true))
                  .map((row) => (
                    <DeploymentCard
                      key={row.id}
                      row={row}
                      active={false}
                      busy={busy}
                      onOpenRun={(url) => window.open(url, '_blank', 'noreferrer')}
                      onRollback={() =>
                        setActionError('Rollback lands with the image history view')
                      }
                    />
                  ))}
              </>
            ) : null}
          </div>
        </div>
      ) : null}

      {tab === 'Variables' ? (
        <VariablesPanel serviceId={serviceId} envId={link?.environmentId ?? ''} />
      ) : null}

      {tab === 'Settings' ? (
        <div className="flex flex-1 flex-col gap-5 overflow-y-auto p-5">
          <section className="flex flex-col gap-2">
            <h3 className="font-mono text-[10px] uppercase tracking-wide text-text-dim">source</h3>
            <div className="flex items-center justify-between rounded-md border border-line bg-surface-2/40 px-3 py-2">
              <span className="flex min-w-0 items-center gap-2">
                <Icon name="github" className="h-3.5 w-3.5 text-text-dim" />
                <span className="truncate font-mono text-ui-sm">{record.repoFullName}</span>
              </span>
              <span className="shrink-0 font-mono text-mono-xs text-text-dim">
                {link?.branch ?? '—'}
              </span>
            </div>
            <div className="flex items-center justify-between rounded-md border border-line bg-surface-2/40 px-3 py-2">
              <span className="font-mono text-mono-xs text-text-dim">auto deploy on push</span>
              <span className="font-mono text-mono-xs text-lime">enabled</span>
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="font-mono text-[10px] uppercase tracking-wide text-text-dim">build</h3>
            <dl className="grid grid-cols-[130px_1fr] gap-y-2 font-mono text-mono-xs">
              <dt className="text-text-dim">dockerfile</dt>
              <dd>{record.dockerfilePath}</dd>
              <dt className="text-text-dim">context</dt>
              <dd>{record.contextPath}</dd>
              <dt className="text-text-dim">container port</dt>
              <dd>{record.containerPort ?? 'from EXPOSE'}</dd>
              <dt className="text-text-dim">memory limit</dt>
              <dd>{record.memoryLimitMb ?? 512} MB</dd>
              <dt className="text-text-dim">health path</dt>
              <dd>{link?.healthPath ?? 'none'}</dd>
              <dt className="text-text-dim">generated host</dt>
              <dd className="break-all">{link?.generatedHost ?? '—'}</dd>
              <dt className="text-text-dim">custom domain</dt>
              <dd>{link?.customDomain ?? 'none'}</dd>
            </dl>
          </section>

          <section className="flex flex-col gap-2 rounded-md border border-red/30 bg-red/5 p-3">
            <h3 className="font-mono text-[10px] uppercase tracking-wide text-red">danger zone</h3>
            <p className="text-ui-sm text-text-dim">
              Deleting stops the container, removes the route, and destroys this service&apos;s
              deployment history and variables. The GitHub workflow file stays.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={confirmDelete}
                onChange={(event) => setConfirmDelete(event.target.value)}
                placeholder={`type "${record.name}" to confirm`}
                aria-label="Type the service name to confirm deletion"
                className="h-7 w-[200px] rounded border border-line bg-surface px-2 font-mono text-mono-xs"
              />
              <Button
                variant="primary"
                className="border-red bg-red text-canvas hover:bg-red/90"
                disabled={deleting || confirmDelete.trim() !== record.name}
                onClick={removeService}
              >
                {deleting ? 'Deleting…' : 'Delete service'}
              </Button>
            </div>
          </section>
        </div>
      ) : null}
    </aside>
  );
}

void navigate;
