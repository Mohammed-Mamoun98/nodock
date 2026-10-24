import { Icon } from './Icon';

interface TopBarProps {
  project: string;
  environment: string;
  ghcr: 'ok' | 'warn' | 'error';
  reconnecting?: boolean;
  avatarUrl?: string;
}

const ghcrTone: Record<TopBarProps['ghcr'], { dot: string; label: string }> = {
  ok: { dot: 'bg-lime', label: 'GHCR ok' },
  warn: { dot: 'bg-amber', label: 'GHCR token expiring' },
  error: { dot: 'bg-red', label: 'GHCR pull failed' },
};

export function TopBar({ project, environment, ghcr, reconnecting, avatarUrl }: TopBarProps) {
  const tone = ghcrTone[ghcr];

  return (
    <>
      {reconnecting ? (
        <div className="flex h-7 shrink-0 items-center justify-center border-b border-amber/20 bg-amber/10 px-4">
          <div className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-amber" aria-hidden />
            <span className="font-mono text-mono-xs text-amber">reconnecting to live updates</span>
          </div>
        </div>
      ) : null}

      <header className="flex h-[56px] shrink-0 items-center justify-between border-b border-line bg-surface px-4">
        <div className="flex items-center gap-4">
          <a href="#/" className="flex items-center gap-2">
            <span className="h-2 w-2 bg-lime" aria-hidden />
            <span className="font-sans text-ui-lg font-semibold">nodock</span>
          </a>

          <button
            type="button"
            className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-line bg-surface-2 px-2.5 text-ui-sm transition-colors hover:border-line-strong"
          >
            {project}
            <Icon name="chevron-down" className="text-text-dim" />
          </button>

          <span className="flex h-7 items-center rounded-md border border-lime/30 px-2.5 text-ui-sm text-lime">
            {environment}
          </span>
        </div>

        <div className="flex items-center gap-5">
          <span className="hidden font-mono text-mono-xs text-text-dim sm:inline">⌘K</span>

          <span className="flex items-center gap-1.5">
            <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} aria-hidden />
            <span className="font-mono text-mono-xs text-text-dim">{tone.label}</span>
          </span>

          {avatarUrl ? (
            <img src={avatarUrl} alt="" className="h-7 w-7 rounded-full border border-line" />
          ) : (
            <span className="h-7 w-7 rounded-full border border-line bg-surface-2" aria-hidden />
          )}
        </div>
      </header>
    </>
  );
}
