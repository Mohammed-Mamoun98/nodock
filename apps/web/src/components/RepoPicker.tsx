import { useMemo, useState } from 'react';
import type { RepoOption } from '../lib/api';
import { Icon } from './Icon';

interface RepoPickerProps {
  repos: RepoOption[];
  selected: string | null;
  onSelect: (repo: RepoOption) => void;
  truncated: boolean;
}

/** Search + list. Native elements only: no dropdown library, no portal, no floating UI. */
export function RepoPicker({ repos, selected, onSelect, truncated }: RepoPickerProps) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = needle
      ? repos.filter((repo) => repo.fullName.toLowerCase().includes(needle))
      : repos;

    // Pushable, recently pushed repos first; archived ones never deploy anything.
    return matches.toSorted((a, b) => {
      if (a.archived !== b.archived) return a.archived ? 1 : -1;
      return (b.pushedAt ?? '').localeCompare(a.pushedAt ?? '');
    });
  }, [repos, query]);

  return (
    <div className="overflow-hidden rounded-md border border-line">
      <div className="flex items-center gap-2 border-b border-line bg-surface-2 px-3">
        <Icon name="search" className="text-text-dim" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search repositories…"
          aria-label="Search repositories"
          className="h-9 flex-1 bg-transparent font-mono text-ui-sm outline-none placeholder:text-text-dim"
        />
        <span className="font-mono text-mono-xs text-text-dim">{filtered.length}</span>
      </div>

      <ul className="max-h-[240px] overflow-y-auto">
        {filtered.length === 0 ? (
          <li className="px-3 py-4 text-ui-sm text-text-dim">No repositories match.</li>
        ) : null}

        {filtered.map((repo) => {
          const active = repo.fullName === selected;
          return (
            <li key={repo.fullName}>
              <button
                type="button"
                onClick={() => onSelect(repo)}
                aria-current={active ? 'true' : undefined}
                className={`flex w-full items-center justify-between gap-3 border-b border-line/60 border-l-2 px-3 py-2 text-left transition-colors last:border-b-0 ${
                  active
                    ? 'border-l-lime bg-surface-2'
                    : 'border-l-transparent hover:bg-surface-2/50'
                }`}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate font-mono text-ui-sm">{repo.fullName}</span>
                  {repo.private ? (
                    <span className="shrink-0 rounded border border-line px-1 font-mono text-[9px] uppercase text-text-dim">
                      private
                    </span>
                  ) : null}
                  {repo.archived ? (
                    <span className="shrink-0 rounded border border-amber/30 px-1 font-mono text-[9px] uppercase text-amber">
                      archived
                    </span>
                  ) : null}
                </span>
                <span className="shrink-0 font-mono text-mono-xs text-text-dim">
                  {repo.defaultBranch}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {truncated ? (
        <p className="border-t border-line bg-surface-2 px-3 py-1.5 font-mono text-mono-xs text-text-dim">
          Showing the 300 most recently pushed repositories.
        </p>
      ) : null}
    </div>
  );
}
