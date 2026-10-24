import { useState } from 'react';
import { DeployRow } from '../components/DeployRow';
import { Icon } from '../components/Icon';
import { LogStream } from '../components/LogStream';
import { Button, LinkButton, StatusWord } from '../components/ui';
import { deployLog, deployments, services } from '../lib/fixtures';
import { stateMeta } from '../lib/status';

const tabs = ['Deployments', 'Logs', 'Variables', 'Settings'] as const;
type Tab = (typeof tabs)[number];

export function ServicePage({ serviceId }: { serviceId: string }) {
  const [tab, setTab] = useState<Tab>('Deployments');
  const service = services.find((s) => s.id === serviceId);

  if (!service) {
    return (
      <main className="flex flex-1 items-center justify-center p-8">
        <div className="rounded-lg border border-line bg-surface p-8 text-center">
          <h1 className="mb-2 text-ui-lg font-medium">No service called {serviceId}</h1>
          <LinkButton to="#/">Back to project</LinkButton>
        </div>
      </main>
    );
  }

  const meta = stateMeta[service.state];
  const host = `${service.name}.apps.nodock.dev`;

  return (
    <main className="relative flex flex-1 flex-col overflow-hidden bg-canvas">
      <div className="flex items-center gap-2 border-b border-line px-6 py-2 font-mono text-mono-xs text-text-dim">
        <a href="#/" className="hover:text-text">
          milo
        </a>
        <span className="opacity-50">/</span>
        <span>Production</span>
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
            <Button>
              Open URL
              <Icon name="arrow-up-right" />
            </Button>
            <Button variant="primary">Redeploy</Button>
            <Button variant="ghost" aria-label="More actions">
              <Icon name="more-horizontal" />
            </Button>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="font-mono text-mono-xs text-text">{host}</span>
          <button
            type="button"
            aria-label="Copy hostname"
            className="text-text-dim hover:text-text"
          >
            <Icon name="copy" />
          </button>
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

      {tab === 'Deployments' ? (
        <div className="flex flex-1 flex-col overflow-hidden">
          <div className="grid grid-cols-[48px_70px_1fr_60px] gap-2 border-b border-line px-5 py-2 font-mono text-[10px] uppercase tracking-wide text-text-dim">
            <span>#id</span>
            <span>status</span>
            <span>commit · trigger · duration</span>
            <span className="text-right">age</span>
          </div>
          <div className="flex-1 overflow-y-auto">
            {deployments.map((deployment, index) => (
              <DeployRow key={deployment.id} deployment={deployment} isHead={index === 0} />
            ))}
          </div>
          <div className="border-t border-line p-4">
            <LogStream lines={deployLog} height={150} />
          </div>
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center p-8">
          <div className="w-[420px] rounded-lg border border-dashed border-line bg-surface/50 p-6 text-center">
            <h2 className="mb-2 text-ui-base font-medium">
              {tab} for {service.name}
            </h2>
            <p className="text-ui-sm text-text-dim">
              {tab === 'Logs'
                ? 'Runtime follow streams from the container over SSE — one stream per tab.'
                : 'Repo, branch, Dockerfile path, context, port, health path, and the danger zone.'}
            </p>
          </div>
        </div>
      )}
    </main>
  );
}
