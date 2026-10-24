import { useState } from 'react';
import { Icon } from '../components/Icon';
import { Button, LinkButton } from '../components/ui';
import { getService, getVariables, saveVariables, type VariableRow } from '../lib/api';
import { useAsync } from '../lib/useAsync';

/** Kept out of the component: calling Date during render is unstable. */
function formatStamp(): string {
  return new Date().toLocaleTimeString();
}

interface Draft {
  /** Stable identity for the row: keys are editable, so they cannot be the key. */
  id: string;
  key: string;
  value: string;
  isSecret: boolean;
}

export function VariablesPage({ serviceId }: { serviceId: string }) {
  const service = useAsync(() => getService(serviceId), [serviceId]);
  const envId = service.data?.serviceEnvs[0]?.environmentId ?? null;

  const list = useAsync(
    () => (envId ? getVariables(serviceId, envId, true) : Promise.resolve({ variables: [] })),
    [serviceId, envId],
  );

  const [edits, setEdits] = useState<Record<string, Draft> | null>(null);
  const [dirty, setDirty] = useState(false);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rows: VariableRow[] = list.data?.variables ?? [];
  // Server rows are the source of truth until the operator edits; after that the
  // edit map wins, so a reload cannot silently discard typing.
  const drafts: Draft[] = edits
    ? Object.values(edits)
    : rows.map((row) => ({
        id: `row-${row.key}`,
        key: row.key,
        value: row.value,
        isSecret: row.isSecret,
      }));

  const setDrafts = (mutate: (current: Draft[]) => Draft[]) => {
    setEdits(Object.fromEntries(mutate(drafts).map((draft) => [draft.id, draft])));
    setDirty(true);
  };

  const update = (id: string, patch: Partial<Draft>) => {
    setDrafts((current) =>
      current.map((draft) => (draft.id === id ? { ...draft, ...patch } : draft)),
    );
  };

  const save = async () => {
    if (!envId) return;
    setSaving(true);
    setError(null);
    try {
      await saveVariables(
        serviceId,
        envId,
        drafts.filter((draft) => draft.key.trim().length > 0),
      );
      setSavedAt(formatStamp());
      setDirty(false);
      setEdits(null);
      list.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  if (service.loading && !service.data) {
    return (
      <main className="flex flex-1 items-center justify-center">
        <span className="font-mono text-mono-xs text-text-dim">loading variables…</span>
      </main>
    );
  }

  if (service.error || !service.data) {
    return (
      <main className="flex flex-1 items-center justify-center p-8">
        <div className="rounded-lg border border-line bg-surface p-8 text-center">
          <h1 className="mb-2 text-ui-lg font-medium">Could not load {serviceId}</h1>
          <p className="mb-4 font-mono text-mono-xs text-text-dim">{service.error?.message}</p>
          <LinkButton to="#/">Back</LinkButton>
        </div>
      </main>
    );
  }

  const environment = service.data.serviceEnvs[0];
  const environmentName = environment?.environmentId ?? 'production';

  return (
    <main className="relative flex flex-1 flex-col overflow-y-auto bg-canvas">
      <div className="flex items-center gap-2 border-b border-line px-6 py-2 font-mono text-mono-xs text-text-dim">
        <a href={`#/services/${serviceId}`} className="hover:text-text">
          {service.data.service.name}
        </a>
        <span className="opacity-50">/</span>
        <span className="text-text">variables</span>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-5">
        <h1 className="text-[20px] font-semibold">Variables</h1>
        <div className="flex items-center gap-3">
          <span className="font-mono text-mono-xs text-text-dim">{drafts.length} variables</span>
          <span className="text-ui-sm text-text-dim">
            Applies to {service.data.service.name} in {environmentName}
          </span>
        </div>
      </div>

      {dirty ? (
        <div className="mx-6 mb-4 flex items-center justify-between rounded-md border border-amber/30 bg-amber/10 px-3 py-2">
          <span className="font-mono text-mono-xs text-amber">
            Unsaved changes — deploy uses the saved values
          </span>
          <span className="font-mono text-mono-xs text-amber">{drafts.length} rows</span>
        </div>
      ) : null}

      {error ? (
        <div className="mx-6 mb-4 rounded-md border border-red/30 bg-red/10 px-3 py-2 font-mono text-mono-xs text-red">
          {error}
        </div>
      ) : null}

      <div className="flex flex-col gap-6 px-6 pb-24 lg:flex-row">
        <div className="w-full max-w-[720px] overflow-hidden rounded-lg border border-line bg-surface">
          <div className="grid grid-cols-[1fr_1fr_80px] gap-3 border-b border-line px-4 py-2 font-mono text-[10px] uppercase tracking-wide text-text-dim">
            <span>key</span>
            <span>value</span>
            <span className="text-right">actions</span>
          </div>

          {drafts.length === 0 ? (
            <p className="px-4 py-6 text-ui-sm text-text-dim">
              No variables yet. Add the ones your service needs to boot.
            </p>
          ) : null}

          {drafts.map((draft, index) => {
            const isRevealed = revealed.has(draft.id) || !draft.isSecret;
            return (
              <div
                key={draft.id}
                className="group grid grid-cols-[1fr_1fr_80px] items-center gap-3 border-b border-line px-4 py-2"
              >
                <input
                  value={draft.key}
                  onChange={(event) => update(draft.id, { key: event.target.value.toUpperCase() })}
                  aria-label={`Variable key ${index + 1}`}
                  className="h-7 rounded border border-transparent bg-transparent px-2 font-mono text-mono-xs focus-visible:border-lime"
                />
                <div className="flex items-center gap-2">
                  <input
                    value={isRevealed ? draft.value : '••••••••'}
                    onChange={(event) => update(draft.id, { value: event.target.value })}
                    aria-label={`Variable value ${index + 1}`}
                    className="h-7 w-full rounded border border-transparent bg-transparent px-2 font-mono text-mono-xs focus-visible:border-lime"
                  />
                  {draft.isSecret ? (
                    <span className="font-mono text-[9px] uppercase text-steel">secret</span>
                  ) : null}
                </div>
                <div className="flex items-center justify-end gap-2 text-text-dim">
                  {draft.isSecret ? (
                    <button
                      type="button"
                      aria-label={isRevealed ? 'Hide value' : 'Reveal value'}
                      onClick={() =>
                        setRevealed((current) => {
                          const next = new Set(current);
                          if (next.has(draft.id)) next.delete(draft.id);
                          else next.add(draft.id);
                          return next;
                        })
                      }
                      className="hover:text-text"
                    >
                      <Icon name={isRevealed ? 'eye-off' : 'eye'} />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    aria-label={`Remove ${draft.key || 'row'}`}
                    onClick={() => {
                      setDrafts((current) => current.filter((row) => row.id !== draft.id));
                    }}
                    className="opacity-0 transition-opacity hover:text-red group-hover:opacity-100"
                  >
                    <Icon name="trash" />
                  </button>
                </div>
              </div>
            );
          })}

          <button
            type="button"
            onClick={() => {
              setDrafts((current) => [
                ...current,
                { id: crypto.randomUUID(), key: '', value: '', isSecret: true },
              ]);
            }}
            className="flex w-full items-center gap-2 border-t border-dashed border-line px-4 py-2.5 font-mono text-mono-xs text-text-dim hover:text-text"
          >
            <Icon name="plus" />
            Add variable
          </button>
        </div>

        <div className="flex w-full flex-col gap-3 lg:w-[280px]">
          <div className="rounded-lg border border-line bg-surface p-4">
            <h2 className="mb-1.5 text-ui-sm font-medium">Encrypted at rest</h2>
            <p className="text-ui-sm text-text-dim">
              Values are sealed with AES-256-GCM using a key derived from{' '}
              <span className="font-mono text-[11px]">NODOCK_SECRET</span>. Lose that secret and the
              variables are unrecoverable.
            </p>
          </div>
          {savedAt ? (
            <div className="rounded-lg border border-lime/30 bg-surface p-4 font-mono text-mono-xs text-lime">
              saved at {savedAt}
            </div>
          ) : null}
        </div>
      </div>

      <div className="sticky bottom-0 flex items-center justify-between border-t border-line bg-surface px-6 py-3">
        <span className="font-mono text-mono-xs text-text-dim">
          {dirty ? 'unsaved changes' : 'in sync'}
        </span>
        <div className="flex items-center gap-2">
          <LinkButton to={`#/services/${serviceId}`} variant="ghost">
            Back
          </LinkButton>
          <Button variant="primary" onClick={save} disabled={!dirty || saving || !envId}>
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </div>
    </main>
  );
}
