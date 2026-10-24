import { useState } from 'react';
import { Icon } from '../components/Icon';
import { Button, LinkButton } from '../components/ui';
import { services, stagingOnlyKeys, variables } from '../lib/fixtures';

export function VariablesPage({ serviceId }: { serviceId: string }) {
  const service = services.find((s) => s.id === serviceId);
  const [rows, setRows] = useState(variables);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [edited, setEdited] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState(true);

  const toggleReveal = (key: string) =>
    setRevealed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const edit = (key: string, value: string) => {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, value } : row)));
    setEdited((current) => new Set(current).add(key));
  };

  return (
    <main className="relative flex flex-1 flex-col overflow-y-auto bg-canvas">
      <div className="flex items-center gap-2 border-b border-line px-6 py-2 font-mono text-mono-xs text-text-dim">
        <a href="#/" className="hover:text-text">
          milo
        </a>
        <span className="opacity-50">/</span>
        <span>Production</span>
        <span className="opacity-50">/</span>
        <a href={`#/services/${serviceId}`} className="text-text hover:underline">
          {service?.name ?? serviceId}
        </a>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-5">
        <h1 className="text-[20px] font-semibold">Variables</h1>
        <div className="flex items-center gap-3">
          <select className="h-7 rounded-md border border-line bg-surface-2 px-2 text-ui-sm">
            <option>Production</option>
            <option>Staging</option>
          </select>
          <span className="font-mono text-mono-xs text-text-dim">{rows.length} variables</span>
          <span className="text-ui-sm text-text-dim">Applies to {service?.name ?? serviceId} in Production</span>
        </div>
      </div>

      {notice ? (
        <div className="mx-6 mb-4 flex items-center justify-between rounded-md border border-amber/30 bg-amber/10 px-3 py-2">
          <span className="font-mono text-mono-xs text-amber">Variables changed — redeploy to apply</span>
          <div className="flex items-center gap-3">
            <Button variant="ghost" className="h-6 px-2 text-amber hover:text-amber">
              Redeploy {service?.name ?? serviceId}
            </Button>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => setNotice(false)}
              className="text-amber/70 hover:text-amber"
            >
              <Icon name="x" />
            </button>
          </div>
        </div>
      ) : null}

      <div className="flex flex-col gap-6 px-6 pb-24 lg:flex-row">
        <div className="w-full max-w-[720px] overflow-hidden rounded-lg border border-line bg-surface">
          <div className="grid grid-cols-[1fr_1fr_80px] gap-3 border-b border-line px-4 py-2 font-mono text-[10px] uppercase tracking-wide text-text-dim">
            <span>key</span>
            <span>value</span>
            <span className="text-right">actions</span>
          </div>

          {rows.map((row) => {
            const isRevealed = revealed.has(row.key);
            const isEdited = edited.has(row.key);
            return (
              <div
                key={row.key}
                className="group grid grid-cols-[1fr_1fr_80px] items-center gap-3 border-b border-line px-4 py-2"
              >
                <input
                  value={row.key}
                  readOnly
                  className={`h-7 rounded border bg-transparent px-2 font-mono text-mono-xs ${
                    isEdited ? 'border-lime' : 'border-transparent'
                  }`}
                />
                <div className="flex items-center gap-2">
                  <input
                    value={isRevealed || !row.secret ? row.value : '••••••••••••'}
                    onChange={(event) => edit(row.key, event.target.value)}
                    type={isRevealed || !row.secret ? 'text' : 'password'}
                    aria-label={`${row.key} value`}
                    className="h-7 w-full rounded border border-transparent bg-transparent px-2 font-mono text-mono-xs"
                  />
                  {row.secret ? <span className="font-mono text-[9px] uppercase text-steel">secret</span> : null}
                </div>
                <div className="flex items-center justify-end gap-2 text-text-dim">
                  {row.secret ? (
                    <button
                      type="button"
                      aria-label={`${isRevealed ? 'Hide' : 'Reveal'} ${row.key}`}
                      onClick={() => toggleReveal(row.key)}
                      className="hover:text-text"
                    >
                      <Icon name={isRevealed ? 'eye-off' : 'eye'} />
                    </button>
                  ) : null}
                  <button type="button" aria-label={`Copy ${row.key}`} className="hover:text-text">
                    <Icon name="copy" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove ${row.key}`}
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
            className="flex w-full items-center gap-2 border-t border-dashed border-line px-4 py-2.5 font-mono text-mono-xs text-text-dim hover:text-text"
          >
            <Icon name="plus" />
            Add variable
          </button>
        </div>

        <div className="flex w-full flex-col gap-3 lg:w-[280px]">
          <div className="rounded-lg border border-line bg-surface p-4">
            <h2 className="mb-1.5 text-ui-sm font-medium">Encrypted at rest</h2>
            <p className="text-ui-xs text-text-dim">
              Values are sealed with AES-256-GCM using a key derived from{' '}
              <span className="font-mono text-[11px]">NODOCK_SECRET</span>. Lose that secret and the
              variables are unrecoverable.
            </p>
          </div>

          <div className="rounded-lg border border-line bg-surface p-4">
            <h2 className="mb-2 text-ui-sm font-medium">Staging differs</h2>
            <ul className="flex flex-col gap-1 font-mono text-mono-xs text-text-dim">
              {stagingOnlyKeys.map((key) => (
                <li key={key} className="flex items-center justify-between">
                  <span>{key}</span>
                  <span className="text-steel">only in staging</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      <div className="sticky bottom-0 flex items-center justify-between border-t border-line bg-surface px-6 py-3">
        <span className="font-mono text-mono-xs text-text-dim">{edited.size} unsaved</span>
        <div className="flex items-center gap-2">
          <LinkButton to={`#/services/${serviceId}`} variant="ghost">
            Discard
          </LinkButton>
          <Button variant="primary" disabled={edited.size === 0}>
            Save changes
          </Button>
        </div>
      </div>
    </main>
  );
}
