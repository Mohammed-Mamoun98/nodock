import { Icon } from './Icon';

/**
 * Railway-style narrow rail: project-level destinations as icons only.
 * Project and environment switching live in the top bar.
 */
export function IconRail({
  activePath,
  controlPlaneMb,
  projectCount,
}: {
  activePath: 'canvas' | 'new-service' | 'settings';
  controlPlaneMb: number | null;
  projectCount: number;
}) {
  const items: {
    id: 'canvas' | 'new-service' | 'settings';
    href: string;
    label: string;
    icon: 'grid' | 'plus' | 'settings';
  }[] = [
    { id: 'canvas', href: '#/', label: 'Canvas', icon: 'grid' },
    { id: 'new-service', href: '#/services/new', label: 'New service', icon: 'plus' },
    { id: 'settings', href: '#/settings', label: 'Project settings', icon: 'settings' },
  ];

  return (
    <aside className="hidden w-[64px] shrink-0 flex-col items-center border-r border-line bg-surface py-4 lg:flex">
      <nav className="flex flex-col items-center gap-1.5">
        {items.map((item) => {
          const active = item.id === activePath;
          return (
            <a
              key={item.id}
              href={item.href}
              title={item.label}
              aria-label={item.label}
              aria-current={active ? 'page' : undefined}
              className={`flex h-10 w-10 items-center justify-center rounded-md transition-colors ${
                active
                  ? 'bg-surface-2 text-lime'
                  : 'text-text-dim hover:bg-surface-2/60 hover:text-text'
              }`}
            >
              <Icon name={item.icon} className="h-[18px] w-[18px]" />
            </a>
          );
        })}
      </nav>

      <div className="mt-auto flex flex-col items-center gap-2">
        <span
          title={`${projectCount} project${projectCount === 1 ? '' : 's'} · control plane ${
            controlPlaneMb === null ? '—' : `${controlPlaneMb} MB`
          }`}
          className="flex h-10 w-10 items-center justify-center rounded-md font-mono text-[10px] text-text-dim"
        >
          {controlPlaneMb === null ? '—' : `${controlPlaneMb}`}
          <span className="ml-0.5 text-[8px] opacity-60">MB</span>
        </span>
      </div>
    </aside>
  );
}
