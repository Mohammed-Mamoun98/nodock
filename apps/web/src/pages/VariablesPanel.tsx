import { useMemo, useState } from 'react';
import { Icon } from '../components/Icon';
import { Button } from '../components/ui';
import { ApiError, getVariableSuggestions, getVariables, saveVariables } from '../lib/api';
import { useAsync } from '../lib/useAsync';

interface Draft {
  id: string;
  key: string;
  value: string;
  isSecret: boolean;
}

const MASK = '••••••••';

/** Railway-style variables: an inline add row, then a flat masked list. */
export function VariablesPanel({ serviceId, envId }: { serviceId: string; envId: string }) {
  const variables = useAsync(
    () => (envId ? getVariables(serviceId, envId, true) : Promise.resolve({ variables: [] })),
    [serviceId, envId],
  );

  // What the repo asks for. Names only: a template's values are placeholders, so the rows
  // this produces arrive empty and the user supplies the real value.
  const suggestions = useAsync(
    () =>
      envId
        ? getVariableSuggestions(serviceId, envId)
        : Promise.resolve({ source: null, values: [], note: null }),
    [serviceId, envId],
  );

  const [edits, setEdits] = useState<Draft[] | null>(null);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [unpicked, setUnpicked] = useState<Set<string>>(new Set());

  const rows: Draft[] = useMemo(() => {
    if (edits) return edits;
    return (variables.data?.variables ?? []).map((row) => ({
      id: `row-${row.key}`,
      key: row.key,
      value: row.value,
      isSecret: row.isSecret,
    }));
  }, [edits, variables.data]);

  const dirty = edits !== null;

  // The prefixes come from the server, so the tag and the endpoint that selects
  // variables for a build cannot disagree. No toggle: forgetting one is the bug.
  const buildPrefixes = variables.data?.buildTimePrefixes ?? [];
  const isBuildTime = (key: string) => buildPrefixes.some((prefix) => key.startsWith(prefix));
  const anyBuildTime = rows.some((row) => isBuildTime(row.key));

  const pending = suggestions.data?.values ?? [];
  const picked = pending.filter((entry) => !unpicked.has(entry.key));
  const showSuggestions = !dismissed && picked.length > 0;

  function mutate(next: Draft[]) {
    setEdits(next);
    setSavedAt(null);
  }

  function addRow() {
    if (!newKey.trim()) return;
    mutate([
      ...rows,
      { id: `new-${newKey}`, key: newKey.trim().toUpperCase(), value: newValue, isSecret: true },
    ]);
    setNewKey('');
    setNewValue('');
    setAdding(false);
  }

  /** Ticked names land in the list with empty values, unsaved — filling them in is the user's job. */
  function addSuggestions() {
    const existing = new Set(rows.map((row) => row.key));
    const added = picked
      .filter((entry) => !existing.has(entry.key))
      .map((entry) => ({
        id: `suggested-${entry.key}`,
        key: entry.key,
        value: '',
        isSecret: entry.isSecret,
      }));
    if (added.length > 0) mutate([...rows, ...added]);
    setDismissed(true);
    setUnpicked(new Set());
  }

  async function save() {
    if (!envId) return;
    setBusy(true);
    setError(null);
    try {
      await saveVariables(
        serviceId,
        envId,
        rows
          .filter((row) => row.key.trim().length > 0)
          .map((row) => ({
            key: row.key.trim(),
            value: row.value,
            isSecret: row.isSecret,
          })),
      );
      setSavedAt(new Date().toLocaleTimeString());
      setEdits(null);
      variables.reload();
      // Whatever is still unset keeps being offered, so ask the repo again.
      suggestions.reload();
    } catch (cause) {
      setError(cause instanceof ApiError ? `${cause.code} · ${cause.message}` : String(cause));
    } finally {
      setBusy(false);
    }
  }

  if (!envId) {
    return (
      <p className="p-5 font-mono text-mono-xs text-text-dim">This service has no environment.</p>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex flex-col gap-2 border-b border-line p-4">
        {adding ? (
          <div className="flex flex-wrap items-center gap-2">
            <input
              autoFocus
              value={newKey}
              onChange={(event) => setNewKey(event.target.value)}
              placeholder="VARIABLE_NAME"
              aria-label="Variable name"
              className="h-9 min-w-[140px] flex-1 rounded border border-lime/40 bg-surface-2 px-2 font-mono text-ui-sm"
            />
            <input
              value={newValue}
              onChange={(event) => setNewValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') addRow();
              }}
              placeholder="value"
              aria-label="Variable value"
              className="h-9 min-w-[140px] flex-1 rounded border border-line bg-surface-2 px-2 font-mono text-ui-sm"
            />
            <Button variant="primary" onClick={addRow} disabled={!newKey.trim()}>
              Add
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setAdding(false);
                setNewKey('');
                setNewValue('');
              }}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <div className="flex items-center justify-between">
            <span className="font-mono text-mono-xs text-text-dim">{rows.length} variables</span>
            <div className="flex items-center gap-1">
              <Button variant="ghost" onClick={suggestions.reload} disabled={suggestions.loading}>
                Scan repo
              </Button>
              <Button onClick={() => setAdding(true)}>+ Add variable</Button>
            </div>
          </div>
        )}

        {error ? (
          <p className="rounded border border-red/30 bg-red/10 px-2 py-1 font-mono text-mono-xs text-red">
            {error}
          </p>
        ) : null}
      </div>

      {showSuggestions ? (
        <div className="border-b border-line bg-lime/5 px-4 py-3">
          <p className="mb-2 text-ui-sm">
            <span className="font-mono text-mono-xs text-text-dim">
              {suggestions.data?.source ?? 'the repo'}
            </span>{' '}
            asks for {picked.length} variable{picked.length === 1 ? '' : 's'} you have not set.
          </p>
          <div className="mb-3 flex flex-wrap gap-1.5">
            {pending.map((entry) => {
              const on = !unpicked.has(entry.key);
              return (
                <label
                  key={entry.key}
                  className={`flex cursor-pointer items-center gap-1.5 rounded border px-2 py-1 font-mono text-mono-xs ${
                    on ? 'border-line bg-surface-2' : 'border-line/50 text-text-dim'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    aria-label={`Add ${entry.key}`}
                    onChange={() =>
                      setUnpicked((current) => {
                        const next = new Set(current);
                        if (next.has(entry.key)) next.delete(entry.key);
                        else next.add(entry.key);
                        return next;
                      })
                    }
                  />
                  {entry.key}
                  {entry.isSecret ? <span className="text-amber">secret</span> : null}
                  {entry.comment ? <span className="text-text-dim">· {entry.comment}</span> : null}
                </label>
              );
            })}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="primary" onClick={addSuggestions} disabled={picked.length === 0}>
              Add {picked.length}
            </Button>
            <Button variant="ghost" onClick={() => setDismissed(true)}>
              Not now
            </Button>
            <span className="font-mono text-mono-xs text-text-dim">
              names only — values stay empty until you fill them in
            </span>
          </div>
        </div>
      ) : null}

      {anyBuildTime ? (
        <p className="border-b border-line bg-amber/5 px-4 py-1.5 font-mono text-mono-xs text-amber">
          Values named {buildPrefixes.slice(0, 3).join(', ')} and friends are baked into the build,
          where anyone who can load the site can read them.
        </p>
      ) : null}

      <div className="flex-1 overflow-y-auto">
        {variables.loading && rows.length === 0 ? (
          <p className="p-4 font-mono text-mono-xs text-text-dim">loading variables…</p>
        ) : null}

        {!variables.loading && rows.length === 0 ? (
          <div className="p-4">
            <div className="rounded-md border border-dashed border-line p-6 text-center">
              <h3 className="mb-1.5 text-ui-base font-medium">No variables</h3>
              <p className="text-ui-sm text-text-dim">
                Add whatever the app needs to boot — DATABASE_URL, secrets, feature flags.
              </p>
              {suggestions.data?.note ? (
                <p className="mt-2 font-mono text-mono-xs text-text-dim">{suggestions.data.note}</p>
              ) : null}
            </div>
          </div>
        ) : null}

        {rows.map((row) => {
          const isRevealed = revealed.has(row.id) || !row.isSecret;
          return (
            <div
              key={row.id}
              className="group flex items-center gap-3 border-b border-line/60 px-5 py-2.5 hover:bg-surface-2/30"
            >
              <input
                value={row.key}
                onChange={(event) =>
                  mutate(
                    rows.map((entry) =>
                      entry.id === row.id
                        ? { ...entry, key: event.target.value.toUpperCase() }
                        : entry,
                    ),
                  )
                }
                aria-label={`Name for ${row.key || 'variable'}`}
                className="h-7 min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 font-mono text-mono-xs focus-visible:border-lime"
              />
              {isBuildTime(row.key) ? (
                <span
                  title="Inlined by the bundler at build time — visible in the artifact"
                  className="shrink-0 rounded border border-amber/30 px-1 py-0.5 font-mono text-mono-xs text-amber"
                >
                  build
                </span>
              ) : null}
              <input
                value={isRevealed ? row.value : MASK}
                onChange={(event) =>
                  mutate(
                    rows.map((entry) =>
                      entry.id === row.id ? { ...entry, value: event.target.value } : entry,
                    ),
                  )
                }
                aria-label={`Value for ${row.key || 'variable'}`}
                className="h-7 min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 font-mono text-mono-xs focus-visible:border-lime"
              />
              <div className="flex shrink-0 items-center gap-1 text-text-dim">
                {row.isSecret ? (
                  <button
                    type="button"
                    aria-label={isRevealed ? 'Hide value' : 'Reveal value'}
                    onClick={() =>
                      setRevealed((current) => {
                        const next = new Set(current);
                        if (next.has(row.id)) next.delete(row.id);
                        else next.add(row.id);
                        return next;
                      })
                    }
                    className="p-1 hover:text-text"
                  >
                    <Icon name={isRevealed ? 'eye-off' : 'eye'} />
                  </button>
                ) : null}
                <button
                  type="button"
                  aria-label={`Copy ${row.key}`}
                  onClick={() => void navigator.clipboard?.writeText(row.value)}
                  className="p-1 hover:text-text"
                >
                  <Icon name="copy" />
                </button>
                <button
                  type="button"
                  aria-label={`Remove ${row.key}`}
                  onClick={() => mutate(rows.filter((entry) => entry.id !== row.id))}
                  className="p-1 opacity-0 transition-opacity hover:text-red group-hover:opacity-100"
                >
                  <Icon name="trash" />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between border-t border-line px-5 py-2.5">
        <span className="font-mono text-mono-xs text-text-dim">
          {dirty ? 'unsaved changes' : savedAt ? `saved ${savedAt}` : 'in sync'}
        </span>
        <div className="flex items-center gap-2">
          {dirty ? (
            <Button
              variant="ghost"
              onClick={() => {
                setEdits(null);
                setRevealed(new Set());
              }}
            >
              Discard
            </Button>
          ) : null}
          <Button variant="primary" onClick={save} disabled={!dirty || busy}>
            {busy ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </div>
    </div>
  );
}
