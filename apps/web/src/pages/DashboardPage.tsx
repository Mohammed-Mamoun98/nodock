import { useState } from 'react';
import { Icon } from '../components/Icon';
import { ServiceCard } from '../components/ServiceCard';
import { LinkButton } from '../components/ui';
import { services } from '../lib/fixtures';
import type { ServiceState } from '../lib/types';

type Filter = 'all' | ServiceState;

const filters: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'live', label: 'Live' },
  { id: 'building', label: 'Building' },
  { id: 'failed', label: 'Failed' },
  { id: 'stopped', label: 'Stopped' },
];

export function DashboardPage() {
  const [filter, setFilter] = useState<Filter>('all');

  const counts = filters.reduce<Record<Filter, number>>(
    (acc, f) => ({ ...acc, [f.id]: f.id === 'all' ? services.length : services.filter((s) => s.state === f.id).length }),
    { all: 0, live: 0, building: 0, failed: 0, stopped: 0 },
  );

  const visible = filter === 'all' ? services : services.filter((s) => s.state === filter);
  const selectedId = services.find((s) => s.state === 'building')?.id ?? services[0]?.id;

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
          <span className="hidden font-mono text-mono-xs tabular text-text-dim sm:inline">
            last deploy 42s ago
          </span>
          <LinkButton to="#/services/new" variant="secondary" className="border-lime text-lime hover:bg-lime/10">
            <Icon name="plus" />
            New service
          </LinkButton>
        </div>
      </div>

      <div className="relative flex flex-1 flex-col p-8">
        {visible.length === 0 ? (
          <div className="flex flex-1 items-center justify-center">
            <div className="flex w-[400px] flex-col items-center rounded-lg border border-dashed border-line bg-surface/50 p-8 text-center">
              <h3 className="mb-2 font-sans text-ui-lg text-text">
                {services.length === 0 ? 'No services yet' : `No ${filter} services`}
              </h3>
              <p className="mb-6 font-sans text-ui-sm text-text-dim">
                {services.length === 0
                  ? 'Connect a repository to deploy your first service.'
                  : 'Nothing matches this filter right now.'}
              </p>
              <LinkButton to="#/services/new" variant="primary" className="px-4">
                <Icon name="plus" />
                New service
              </LinkButton>
            </div>
          </div>
        ) : (
          <>
            <div className="mx-auto grid w-full max-w-[600px] grid-cols-1 justify-items-center gap-x-12 gap-y-8 lg:grid-cols-2">
              {visible.map((service) => (
                <ServiceCard key={service.id} service={service} selected={service.id === selectedId} />
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
        )}
      </div>
    </main>
  );
}
