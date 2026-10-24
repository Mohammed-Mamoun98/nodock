import type { EnvironmentSummary, ProjectSummary } from '../lib/api';
import { SectionLabel } from './ui';

interface LeftRailProps {
  projects: ProjectSummary[];
  environments: EnvironmentSummary[];
  activeProjectId: string | null;
  activeEnvId: string | null;
  controlPlaneMb: number | null;
}

export function LeftRail({
  projects,
  environments,
  activeProjectId,
  activeEnvId,
  controlPlaneMb,
}: LeftRailProps) {
  return (
    <aside className="hidden w-[248px] shrink-0 flex-col border-r border-line bg-surface lg:flex">
      <div className="flex-1 overflow-y-auto py-4">
        <SectionLabel>PROJECTS</SectionLabel>
        <nav className="flex flex-col">
          {projects.length === 0 ? (
            <span className="px-4 font-mono text-mono-xs text-text-dim">none yet</span>
          ) : null}
          {projects.map((project) => {
            const active = project.id === activeProjectId;
            return (
              <a
                key={project.id}
                href="#/"
                aria-current={active ? 'page' : undefined}
                className={`flex h-8 items-center justify-between border-l-2 px-4 text-ui-sm transition-colors ${
                  active ? 'border-lime bg-surface-2' : 'border-transparent hover:bg-surface-2/50'
                }`}
              >
                <span>{project.name}</span>
                <span className="font-mono text-mono-xs text-text-dim">
                  {project.serviceCount ?? 0}
                </span>
              </a>
            );
          })}
        </nav>

        <div className="mt-6">
          <SectionLabel>ENVIRONMENTS</SectionLabel>
        </div>
        <nav className="flex flex-col">
          {environments.map((env) => {
            const active = env.id === activeEnvId;
            return (
              <a
                key={env.id}
                href="#/"
                className="flex h-8 items-center justify-between px-4 text-ui-sm"
              >
                <span className={active ? 'text-lime' : 'text-text-dim'}>{env.name}</span>
                <span className="font-mono text-mono-xs text-text-dim">
                  {env.serviceCount} services
                </span>
              </a>
            );
          })}
        </nav>
      </div>

      <div className="border-t border-line p-4">
        <div className="flex flex-col gap-1 font-mono text-mono-xs text-text-dim">
          <span>control plane {controlPlaneMb === null ? '—' : `${controlPlaneMb} MB`}</span>
          <span>
            {projects.length} project{projects.length === 1 ? '' : 's'}
          </span>
        </div>
      </div>
    </aside>
  );
}
