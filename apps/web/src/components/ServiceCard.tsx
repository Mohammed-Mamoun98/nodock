import { useState } from 'react';
import { primaryAction, stateMeta } from '../lib/status';
import type { ServiceView } from '../lib/view';
import { Icon } from './Icon';
import { BranchChip, StatusWord } from './ui';

export function ServiceCard({ service, selected }: { service: ServiceView; selected: boolean }) {
  const meta = stateMeta[service.state];
  const action = primaryAction(service.state);
  const [copied, setCopied] = useState(false);

  return (
    <article
      className={`flex min-h-[204px] w-full max-w-[320px] flex-col rounded-lg border bg-surface transition-colors ${
        selected ? 'border-line-strong border-t-lime' : 'border-line hover:border-line-strong'
      }`}
    >
      <a href={`#/services/${service.id}`} className="flex flex-1 flex-col p-5">
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <h3 className="truncate font-sans text-ui-lg font-semibold">{service.name}</h3>
          <span className="font-mono text-mono-xs tabular text-text-dim">{service.age}</span>
        </div>

        <div className="mb-3 flex items-center gap-1.5">
          <StatusWord label={meta.label} tone={meta.tone} inFlight={meta.inFlight} />
        </div>

        {service.failure ? (
          <p className="mb-1 font-mono text-mono-xs leading-snug text-red/70">{service.failure}</p>
        ) : null}

        <div className="mt-auto flex flex-col gap-0.5 font-mono text-mono-xs text-text-dim">
          <span className="truncate">{service.repo}</span>
          <div className="flex items-center gap-1">
            <BranchChip branch={service.branch} />
            <span>@{service.sha}</span>
          </div>
        </div>
      </a>

      <div className="flex items-center justify-between border-t border-line px-5 py-3">
        {service.state === 'live' && service.host ? (
          <a
            href={`https://${service.host}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-[32px] items-center gap-1.5 rounded-[6px] border border-line px-3.5 text-ui-sm transition-colors hover:bg-surface-2"
          >
            Open URL
            <Icon name="arrow-up-right" />
          </a>
        ) : (
          <a
            href={`#/services/${service.id}`}
            className={`inline-flex h-[32px] items-center gap-1.5 rounded-[6px] px-3.5 text-ui-sm transition-colors ${
              action.kind === 'primary'
                ? 'bg-lime font-medium text-lime-ink hover:bg-lime/90'
                : 'border border-line text-text hover:bg-surface-2'
            }`}
          >
            {action.label}
          </a>
        )}

        <button
          type="button"
          aria-label={`Copy ${service.name} hostname`}
          onClick={() => {
            if (service.host) void navigator.clipboard?.writeText(service.host);
            setCopied(true);
          }}
          onBlur={() => setCopied(false)}
          disabled={!service.host}
          className="p-1 text-text-dim transition-colors hover:text-text disabled:opacity-40"
        >
          <Icon name={copied ? 'check' : 'copy'} />
        </button>
      </div>
    </article>
  );
}
