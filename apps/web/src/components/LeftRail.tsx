import type { EnvironmentRef, Project } from '../lib/types';
import { SectionLabel } from './ui';

interface LeftRailProps {
  projects: Project[];
  environments: EnvironmentRef[];
  activeProject: string;
  controlPlaneMb: number | null;
  deploysToday: number;
}

export function LeftRail({
  projects,
  environments,
  activeProject,
  controlPlaneMb,
  deploysToday,
}: LeftRailProps) {
  return (
    <aside className="hidden w-[248px] shrink-0 flex-col border-r border-line bg-surface lg:flex">
      <div className="flex-1 overflow-y-auto py-4">
        <SectionLabel>PROJECTS</SectionLabel>
        <nav className="flex flex-col">
          {projects.map((project) => {
            const active = project.id === activeProject;
            return (
              <a
                key={project.id}
                href="#/"
                aria-current={active ? 'page' : undefined}
                className={`flex h-8 items-center justify-between border-l-2 px-4 text-ui-sm transition-colors ${
                  active ? 'border-lime bg-surface-2' : 'border-transparent hover:bg-surface-2/50'
                } ${project.serviceCount === 0 ? 'text-text-dim' : ''}`}
              >
                <span>{project.name}</span>
                {project.serviceCount > 0 ? (
                  <span className="font-mono text-mono-xs text-text-dim">
                    {project.serviceCount}
                  </span>
                ) : null}
              </a>
            );
          })}
        </nav>

        <div className="mt-6">
          <SectionLabel>ENVIRONMENTS</SectionLabel>
        </div>
        <nav className="flex flex-col">
          {environments.map((env) => (
            <a
              key={env.id}
              href="#/"
              aria-current={env.active ? 'page' : undefined}
              className="flex h-8 items-center justify-between px-4 text-ui-sm"
            >
              <span className={env.active ? 'text-lime' : 'text-text-dim'}>{env.name}</span>
              <span className="font-mono text-mono-xs text-text-dim">
                {env.serviceCount} services
              </span>
            </a>
          ))}
        </nav>
      </div>

      <div className="border-t border-line p-4">
        <div className="flex flex-col gap-1 font-mono text-mono-xs text-text-dim">
          <span>control plane {controlPlaneMb === null ? '—' : `${controlPlaneMb} MB`}</span>
          <span>
            {deploysToday} deploy{deploysToday === 1 ? '' : 's'} today
          </span>
        </div>
      </div>
    </aside>
  );
}
