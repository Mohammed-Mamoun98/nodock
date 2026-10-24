import { useState } from 'react';
import { Icon } from '../components/Icon';
import { Button, LinkButton, StatusWord } from '../components/ui';
import { getService } from '../lib/api';
import { deriveState, relativeAge } from '../lib/view';
import { stateMeta } from '../lib/status';
import { useAsync } from '../lib/useAsync';

const tabs = ['Deployments', 'Logs', 'Variables', 'Settings'] as const;
type Tab = (typeof tabs)[number];

export function ServicePage({ serviceId }: { serviceId: string }) {
  const [tab, setTab] = useState<Tab>('Deployments');
  const { data, error, loading } = useAsync(() => getService(serviceId), [serviceId]);

  if (loading && !data) {
    return (
      <main className="flex flex-1 items-center justify-center">
        <span className="font-mono text-mono-xs text-text-dim">loading service…</span>
      </main>
    );
  }

  if (error || !data) {
    return (
      <main className="flex flex-1 items-center justify-center p-8">
        <div className="rounded-lg border border-line bg-surface p-8 text-center">
          <h1 className="mb-2 text-ui-lg font-medium">
            {error?.status === 404 ? `No service called ${serviceId}` : 'Could not load service'}
          </h1>
          <p className="mb-4 font-mono text-mono-xs text-text-dim">{error?.message}</p>
          <LinkButton to="#/">Back to project</LinkButton>
        </div>
      </main>
    );
  }

  const { service, serviceEnvs } = data;
  const link = serviceEnvs[0] ?? null;
  const latest = link?.latestDeployment ?? null;
  const state = deriveState(latest);
  const meta = stateMeta[state];
  const host = link?.customDomain ?? link?.generatedHost ?? '';

  return (
    <main className="relative flex flex-1 flex-col overflow-hidden bg-canvas">
      <div className="flex items-center gap-2 border-b border-line px-6 py-2 font-mono text-mono-xs text-text-dim">
        <a href="#/" className="hover:text-text">
          back
        </a>
        <span className="opacity-50">/</span>
        <span className="text-text">{service.name}</span>
      </div>

      <div className="flex flex-col gap-3 px-6 py-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <h1 className="text-ui-lg font-semibold">{service.name}</h1>
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
            <Button variant="primary" disabled title="Deploys arrive with the Docker pipeline">
              Deploy
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
            · {service.repoFullName}@{link?.branch ?? '—'}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-5 border-b border-line px-6">
        {tabs.map((t) =>
          t === 'Variables' ? (
            <a
              key={t}
              href={`#/services/${service.id}/variables`}
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

      <div className="flex flex-1 items-center justify-center overflow-y-auto p-8">
        {tab === 'Deployments' ? (
          <div className="w-[460px] rounded-lg border border-dashed border-line bg-surface/50 p-6 text-center">
            <h2 className="mb-2 text-ui-base font-medium">No deployments yet</h2>
            <p className="text-ui-sm text-text-dim">
              Deploy history, the Actions run link, and rollback land with the Docker pipeline.
              {latest ? ` Last attempt: ${latest.status} (${relativeAge(latest.createdAt)}).` : ''}
            </p>
          </div>
        ) : null}

        {tab === 'Logs' ? (
          <div className="w-[460px] rounded-lg border border-dashed border-line bg-surface/50 p-6 text-center">
            <h2 className="mb-2 text-ui-base font-medium">Runtime logs</h2>
            <p className="text-ui-sm text-text-dim">
              Follows the container over SSE once a container exists for this service.
            </p>
          </div>
        ) : null}

        {tab === 'Settings' ? (
          <dl className="grid w-full max-w-[560px] grid-cols-[160px_1fr] gap-y-3 font-mono text-mono-xs">
            <dt className="text-text-dim">repository</dt>
            <dd>{service.repoFullName}</dd>
            <dt className="text-text-dim">branch</dt>
            <dd>{link?.branch ?? '—'}</dd>
            <dt className="text-text-dim">dockerfile</dt>
            <dd>{service.dockerfilePath}</dd>
            <dt className="text-text-dim">context</dt>
            <dd>{service.contextPath}</dd>
            <dt className="text-text-dim">container port</dt>
            <dd>{service.containerPort ?? 'from EXPOSE'}</dd>
            <dt className="text-text-dim">memory limit</dt>
            <dd>{service.memoryLimitMb ?? 512} MB</dd>
            <dt className="text-text-dim">health path</dt>
            <dd>{link?.healthPath ?? 'none'}</dd>
            <dt className="text-text-dim">generated host</dt>
            <dd>{link?.generatedHost ?? '—'}</dd>
            <dt className="text-text-dim">custom domain</dt>
            <dd>{link?.customDomain ?? 'none'}</dd>
          </dl>
        ) : null}
      </div>
    </main>
  );
}
