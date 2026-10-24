import { useState } from 'react';
import { ApiError, createProject } from '../lib/api';

export function CreateProjectPage({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  async function submit() {
    if (!name.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await createProject(name.trim());
      onCreated();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause : new ApiError(0, 'network_error', String(cause)));
      setSubmitting(false);
    }
  }

  return (
    <main className="flex flex-1 items-center justify-center bg-canvas dot-grid p-6">
      <div className="w-[420px] rounded-lg border border-line bg-surface p-8">
        <h1 className="mb-1.5 text-ui-lg font-medium">Create your first project</h1>
        <p className="mb-6 text-ui-sm text-text-dim">
          A project groups services per environment. It starts with Production.
        </p>

        <label htmlFor="project-name" className="mb-2 block text-ui-sm">
          Project name
        </label>
        <input
          id="project-name"
          value={name}
          autoFocus
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submit();
          }}
          placeholder="milo"
          className="mb-4 h-8 w-full rounded-md border border-line bg-surface-2 px-3 font-mono text-ui-sm"
        />

        {error ? (
          <p className="mb-3 font-mono text-mono-xs text-red">
            {error.code} · {error.message}
          </p>
        ) : null}

        <button
          type="button"
          onClick={submit}
          disabled={!name.trim() || submitting}
          className="h-9 w-full rounded-[6px] bg-lime text-ui-sm font-medium text-lime-ink transition-colors hover:bg-lime/90 disabled:opacity-50"
        >
          {submitting ? 'Creating…' : 'Create project'}
        </button>
      </div>
    </main>
  );
}
