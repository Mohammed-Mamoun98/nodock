import { statusMeta } from '../lib/status';
import type { Deployment } from '../lib/types';
import { Icon } from './Icon';
import { StatusChip } from './ui';

export function DeployRow({ deployment, isHead }: { deployment: Deployment; isHead: boolean }) {
  const meta = statusMeta[deployment.status];

  return (
    <div
      className={`group relative border-b border-line px-5 py-3 transition-colors hover:bg-surface-2/30 ${
        isHead ? 'bg-surface-2/10' : ''
      }`}
    >
      {isHead ? <span className="absolute inset-y-0 left-0 w-[2px] bg-amber" aria-hidden /> : null}

      <div className="grid grid-cols-[48px_70px_1fr_60px] items-center gap-2">
        <span className={`font-mono text-mono-xs ${isHead ? 'text-text' : 'text-text-dim'}`}>
          #{deployment.number}
        </span>
        <StatusChip label={meta.label} tone={meta.tone} />
        <div className="flex items-center gap-1 truncate font-mono text-mono-xs text-text-dim">
          <span className="truncate">{deployment.sha}</span>
          <span>@</span>
          <span className="truncate">{deployment.branch}</span>
          {isHead ? <span className="ml-1 text-[9px] uppercase text-amber">head</span> : null}
        </div>
        <span className="text-right font-mono text-mono-xs tabular text-text-dim">
          {deployment.age}
        </span>
      </div>

      <div className="mt-1.5 grid grid-cols-[48px_70px_1fr_60px] items-center gap-2">
        <div className="col-start-3 flex items-center gap-2 font-mono text-mono-xs text-text-dim">
          <span className="tabular">{deployment.duration}</span>
          <span className="opacity-50">·</span>
          <span>{deployment.trigger}</span>
          {deployment.rollbackable && !isHead ? (
            <span className="opacity-0 transition-opacity group-hover:opacity-100">
              <button type="button" className="text-text hover:underline">
                Rollback
              </button>
            </span>
          ) : null}
        </div>
        <div className="col-start-4 flex justify-end">
          {deployment.runUrl ? (
            <a
              href={deployment.runUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-4 items-center gap-1 whitespace-nowrap rounded border border-lime px-1.5 font-mono text-[10px] text-lime transition-colors hover:bg-lime/10"
            >
              Build
              <Icon name="arrow-up-right" className="h-3 w-3" />
            </a>
          ) : null}
        </div>
      </div>
    </div>
  );
}
