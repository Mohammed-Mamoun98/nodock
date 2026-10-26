import { Dropdown } from './Dropdown';
import { Icon } from './Icon';

interface TopBarProps {
  projects: { id: string; name: string; serviceCount?: number }[];
  activeProjectId: string | null;
  onSelectProject: (id: string) => void;
  environments: { id: string; name: string; serviceCount: number; isDefault?: boolean }[];
  activeEnvId: string | null;
  onSelectEnvironment: (id: string) => void;
  ghcr: 'ok' | 'warn' | 'error';
  reconnecting?: boolean;
  avatarUrl?: string | null;
  login?: string;
  needsReconnect?: boolean;
  onSignOut?: () => void;
}

const ghcrTone: Record<TopBarProps['ghcr'], { dot: string; label: string }> = {
  ok: { dot: 'bg-lime', label: 'GHCR ok' },
  warn: { dot: 'bg-amber', label: 'GHCR token' },
  error: { dot: 'bg-red', label: 'GHCR failed' },
};

export function TopBar({
  projects,
  activeProjectId,
  onSelectProject,
  environments,
  activeEnvId,
  onSelectEnvironment,
  ghcr,
  reconnecting,
  avatarUrl,
  login,
  needsReconnect,
  onSignOut,
}: TopBarProps) {
  const tone = ghcrTone[ghcr];
  const activeProject = projects.find((project) => project.id === activeProjectId);
  const activeEnv = environments.find((env) => env.id === activeEnvId);

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

      <header className="flex h-[60px] shrink-0 items-center gap-4 border-b border-line bg-surface px-4">
        <a href="#/" className="flex shrink-0 items-center gap-2 pl-1">
          <span className="h-2 w-2 bg-lime" aria-hidden />
          <span className="font-sans text-ui-lg font-semibold">nodock</span>
        </a>

        <span className="text-text-dim" aria-hidden>
          /
        </span>

        <Dropdown
          ariaLabel="Switch project"
          label={activeProject?.name ?? 'no project'}
          items={projects.map((project) => ({
            id: project.id,
            label: project.name,
            meta: String(project.serviceCount ?? 0),
          }))}
          activeId={activeProjectId}
          onSelect={onSelectProject}
          emptyLabel="no projects yet"
        />

        <span className="text-text-dim" aria-hidden>
          /
        </span>

        <Dropdown
          ariaLabel="Switch environment"
          label={activeEnv?.name ?? 'Production'}
          items={environments.map((env) => ({
            id: env.id,
            label: env.name,
            meta: env.isDefault ? 'default' : `${env.serviceCount}`,
          }))}
          activeId={activeEnvId}
          onSelect={onSelectEnvironment}
          emptyLabel="no environments"
        />

        <div className="ml-auto flex items-center gap-4">
          {needsReconnect ? (
            <a
              href="/auth/github"
              className="hidden items-center gap-1.5 rounded border border-amber/30 px-2.5 py-1.5 font-mono text-mono-xs text-amber sm:flex"
            >
              reconnect github
            </a>
          ) : null}

          <span className="hidden items-center gap-1.5 sm:flex">
            <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} aria-hidden />
            <span className="font-mono text-mono-xs text-text-dim">{tone.label}</span>
          </span>

          {onSignOut ? (
            <button
              type="button"
              onClick={onSignOut}
              className="hidden font-mono text-mono-xs text-text-dim transition-colors hover:text-text sm:inline"
            >
              sign out
            </button>
          ) : null}

          {avatarUrl ? (
            <img
              src={avatarUrl}
              alt={login ? `${login} avatar` : ''}
              className="h-8 w-8 rounded-full border border-line"
            />
          ) : (
            <span className="flex h-8 w-8 items-center justify-center rounded-full border border-line bg-surface-2 text-text-dim">
              <Icon name="github" className="h-4 w-4" />
            </span>
          )}
        </div>
      </header>
    </>
  );
}
