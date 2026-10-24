import { useState } from 'react';
import { Icon } from '../components/Icon';
import { Button, LinkButton, StatusChip, StatusWord } from '../components/ui';
import {
  ApiError,
  deployService,
  enableCi,
  getCiStatus,
  getService,
  listDeployments,
  type CiState,
} from '../lib/api';
import { deploymentStatusMeta, stateMeta } from '../lib/status';
import { useAsync } from '../lib/useAsync';
import { deriveState, relativeAge } from '../lib/view';

const tabs = ['Deployments', 'Logs', 'Variables', 'Settings'] as const;
type Tab = (typeof tabs)[number];

function duration(start: string | null, end: string | null): string {
  if (!start) return '—';
  const ms = (end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime();
  const seconds = Math.max(1, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function ServicePage({ serviceId }: { serviceId: string }) {
  const [tab, setTab] = useState<Tab>('Deployments');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [ciBusy, setCiBusy] = useState(false);
  const [ciConflict, setCiConflict] = useState<{ current: string; preview: string } | null>(null);

  const service = useAsync(() => getService(serviceId), [serviceId]);
  const deployments = useAsync(() => listDeployments(serviceId), [serviceId]);

  const repoFullName = service.data?.service.repoFullName ?? '';
  const [owner, repo] = repoFullName.split('/');
  const ci = useAsync<CiState | null>(
    () => (owner && repo ? getCiStatus(owner, repo) : Promise.resolve(null)),
    [owner, repo],
  );

  if (service.loading && !service.data) {
    return (
      <main className="flex flex-1 items-center justify-center">
        <span className="font-mono text-mono-xs text-text-dim">loading service…</span>
      </main>
    );
  }

  if (service.error || !service.data) {
    return (
      <main className="flex flex-1 items-center justify-center p-8">
        <div className="rounded-lg border border-line bg-surface p-8 text-center">
          <h1 className="mb-2 text-ui-lg font-medium">
            {service.error?.status === 404
              ? `No service called ${serviceId}`
              : 'Could not load service'}
          </h1>
          <p className="mb-4 font-mono text-mono-xs text-text-dim">{service.error?.message}</p>
          <LinkButton to="#/">Back to project</LinkButton>
        </div>
      </main>
    );
  }

  const { service: record, serviceEnvs } = service.data;
  const link = serviceEnvs[0] ?? null;
  const rows = deployments.data?.deployments ?? [];
  const latest = rows[0] ?? null;
  const state = deriveState(
    latest
      ? {
          id: latest.id,
          status: latest.status,
          trigger: latest.trigger,
          commitSha: latest.commitSha,
          ciRunUrl: latest.ciRunUrl,
          error: latest.error,
          createdAt: latest.createdAt,
        }
      : null,
  );
  const meta = stateMeta[state];
  const host = link?.customDomain ?? link?.generatedHost ?? '';

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

  async function enable(overwrite = false) {
    if (!owner || !repo) return;
    setCiBusy(true);
    setActionError(null);
    try {
      await enableCi(owner, repo, overwrite);
      setCiConflict(null);
      ci.reload();
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'workflow_exists') {
        setCiConflict(cause.details as { current: string; preview: string });
      } else {
        setActionError(
          cause instanceof ApiError ? `${cause.code} · ${cause.message}` : String(cause),
        );
      }
    } finally {
      setCiBusy(false);
    }
  }

  return (
    <main className="relative flex flex-1 flex-col overflow-hidden bg-canvas">
      <div className="flex items-center gap-2 border-b border-line px-6 py-2 font-mono text-mono-xs text-text-dim">
        <a href="#/" className="hover:text-text">
          back
        </a>
        <span className="opacity-50">/</span>
        <span className="text-text">{record.name}</span>
      </div>

      <div className="flex flex-col gap-3 px-6 py-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <h1 className="text-ui-lg font-semibold">{record.name}</h1>
            <StatusWord label={meta.label} tone={meta.tone} inFlight={meta.inFlight} />
          </div>

          <div className="flex items-center gap-2">
            {host ? (
              <a
                href={`https://${host}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-[28px] items-center gap-1.5 rounded-[6px] border border-line px-3 text-ui-sm hover:bg-surface-2"
              >
                Open URL
                <Icon name="arrow-up-right" />
              </a>
            ) : null}
            <Button variant="primary" onClick={runDeploy} disabled={busy || !link}>
              {busy ? 'Dispatching…' : 'Deploy'}
            </Button>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="font-mono text-mono-xs text-text">{host || 'no host assigned'}</span>
          {host ? (
            <button
              type="button"
              aria-label="Copy hostname"
              onClick={() => void navigator.clipboard?.writeText(host)}
              className="text-text-dim hover:text-text"
            >
              <Icon name="copy" />
            </button>
          ) : null}
          <span className="font-mono text-mono-xs text-text-dim">
            · {record.repoFullName}@{link?.branch ?? '—'}
          </span>
        </div>

        {actionError ? (
          <p className="rounded-md border border-red/30 bg-red/10 px-3 py-2 font-mono text-mono-xs text-red">
            {actionError}
          </p>
        ) : null}
      </div>

      <div className="flex items-center gap-5 border-b border-line px-6">
        {tabs.map((t) =>
          t === 'Variables' ? (
            <a
              key={t}
              href={`#/services/${record.id}/variables`}
              className="-mb-px border-b-2 border-transparent pb-2.5 text-ui-sm text-text-dim hover:text-text"
            >
              {t}
            </a>
          ) : (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              aria-current={tab === t ? 'page' : undefined}
              className={`-mb-px border-b-2 pb-2.5 text-ui-sm transition-colors ${
                tab === t
                  ? 'border-lime font-medium text-text'
                  : 'border-transparent text-text-dim hover:text-text'
              }`}
            >
              {t}
            </button>
          ),
        )}
      </div>

      {tab === 'Deployments' ? (
        <div className="flex flex-1 flex-col overflow-hidden">
          <div className="grid grid-cols-[52px_80px_1fr_90px_70px] gap-2 border-b border-line px-5 py-2 font-mono text-[10px] uppercase tracking-wide text-text-dim">
            <span>#</span>
            <span>status</span>
            <span>commit · trigger</span>
            <span>duration</span>
            <span className="text-right">age</span>
          </div>

          <div className="flex-1 overflow-y-auto">
            {deployments.loading && rows.length === 0 ? (
              <p className="px-5 py-4 font-mono text-mono-xs text-text-dim">loading deployments…</p>
            ) : null}

            {!deployments.loading && rows.length === 0 ? (
              <div className="flex h-full items-center justify-center p-8">
                <div className="w-[460px] rounded-lg border border-dashed border-line bg-surface/50 p-6 text-center">
                  <h2 className="mb-2 text-ui-base font-medium">No deployments yet</h2>
                  <p className="text-ui-sm text-text-dim">
                    Enable CI for this repository, then deploy — GitHub Actions builds and nodock
                    pulls the result.
                  </p>
                </div>
              </div>
            ) : null}

            {rows.map((row, index) => {
              const chip = deploymentStatusMeta[row.status];
              return (
                <div
                  key={row.id}
                  className="grid grid-cols-[52px_80px_1fr_90px_70px] items-center gap-2 border-b border-line px-5 py-2.5 font-mono text-mono-xs hover:bg-surface-2/30"
                >
                  <span className={index === 0 ? 'text-text' : 'text-text-dim'}>
                    #{rows.length - index}
                  </span>
                  <StatusChip label={chip.label} tone={chip.tone} />
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="flex items-center gap-1 truncate text-text-dim">
                      <span className="truncate">{row.commitSha?.slice(0, 7) ?? '—'}</span>
                      <span>· {row.trigger}</span>
                      {index === 0 ? (
                        <span className="text-[9px] uppercase text-amber">head</span>
                      ) : null}
                    </span>
                    {row.error ? (
                      <span className="truncate text-red/80">{row.error}</span>
                    ) : (
                      <span className="truncate opacity-60">{row.imageRef}</span>
                    )}
                  </div>
                  <span className="tabular text-text-dim">
                    {duration(row.startedAt, row.finishedAt)}
                  </span>
                  <div className="flex items-center justify-end gap-2">
                    <span className="tabular text-text-dim">{relativeAge(row.createdAt)}</span>
                    {row.ciRunUrl ? (
                      <a
                        href={row.ciRunUrl}
                        target="_blank"
                        rel="noreferrer"
                        aria-label="Open the GitHub Actions run"
                        className="text-lime hover:opacity-80"
                      >
                        <Icon name="arrow-up-right" className="h-3 w-3" />
                      </a>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {tab === 'Logs' ? (
        <div className="flex flex-1 items-center justify-center p-8">
          <div className="w-[460px] rounded-lg border border-dashed border-line bg-surface/50 p-6 text-center">
            <h2 className="mb-2 text-ui-base font-medium">Runtime logs</h2>
            <p className="text-ui-sm text-text-dim">
              Follows the container over SSE once a container is running.
            </p>
          </div>
        </div>
      ) : null}

      {tab === 'Settings' ? (
        <div className="flex flex-1 flex-col gap-6 overflow-y-auto p-6">
          <section className="rounded-lg border border-line bg-surface p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-ui-base font-medium">Continuous integration</h2>
              {ci.data ? (
                <StatusChip
                  label={ci.data.status.replace('_', ' ')}
                  tone={
                    ci.data.status === 'enabled'
                      ? 'lime'
                      : ci.data.status === 'not_enabled'
                        ? 'steel'
                        : 'amber'
                  }
                />
              ) : null}
            </div>

            <p className="mb-3 font-mono text-mono-xs text-text-dim">
              {ci.data?.workflowPath ?? '.github/workflows/nodock.yml'}
              {ci.data?.reason ? ` · ${ci.data.reason}` : ''}
            </p>

            {ci.error ? (
              <p className="mb-3 font-mono text-mono-xs text-red">{ci.error.message}</p>
            ) : null}

            {ciConflict ? (
              <div className="mb-3 rounded-md border border-amber/30 bg-amber/5 p-3">
                <p className="mb-2 font-mono text-mono-xs text-amber">
                  A different workflow already exists at that path.
                </p>
                <pre className="mb-2 max-h-[120px] overflow-auto rounded border border-line bg-canvas p-2 font-mono text-[10px] text-text-dim">
                  {ciConflict.current.split('\n').slice(0, 8).join('\n')}
                </pre>
                <Button variant="primary" onClick={() => void enable(true)} disabled={ciBusy}>
                  Overwrite it
                </Button>
              </div>
            ) : null}

            {ci.data && ci.data.status !== 'enabled' ? (
              <Button variant="primary" onClick={() => void enable()} disabled={ciBusy || !owner}>
                {ciBusy
                  ? 'Enabling…'
                  : ci.data.status === 'not_enabled'
                    ? 'Enable CI'
                    : 'Re-enable CI'}
              </Button>
            ) : null}
          </section>

          <section>
            <h2 className="mb-3 text-ui-base font-medium">Build</h2>
            <dl className="grid w-full max-w-[560px] grid-cols-[160px_1fr] gap-y-3 font-mono text-mono-xs">
              <dt className="text-text-dim">repository</dt>
              <dd>{record.repoFullName}</dd>
              <dt className="text-text-dim">branch</dt>
              <dd>{link?.branch ?? '—'}</dd>
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
              <dd>{link?.generatedHost ?? '—'}</dd>
              <dt className="text-text-dim">custom domain</dt>
              <dd>{link?.customDomain ?? 'none'}</dd>
            </dl>
          </section>
        </div>
      ) : null}
    </main>
  );
}
