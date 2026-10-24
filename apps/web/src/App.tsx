import { useEffect, useState } from 'react';

interface Health {
  ok: boolean;
  database: 'ok' | 'error';
  uptimeMs: number;
  version: string;
}

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/healthz')
      .then((r) => r.json() as Promise<Health>)
      .then(setHealth)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col gap-6 p-8">
      <header className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">nodock</h1>
        <span className="font-mono text-xs text-neutral-500">v1 scaffold</span>
      </header>

      <section className="rounded-xl border border-neutral-800 p-5">
        <h2 className="mb-3 text-sm font-medium text-neutral-400">Control plane</h2>
        <dl className="grid grid-cols-3 gap-4 font-mono text-sm">
          <div>
            <dt className="text-xs text-neutral-500">status</dt>
            <dd className={health?.ok ? 'text-emerald-400' : 'text-neutral-300'}>
              {error ? 'unreachable' : health ? (health.ok ? 'healthy' : 'degraded') : '…'}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">database</dt>
            <dd>{health?.database ?? '…'}</dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">runtime</dt>
            <dd>bun {health?.version ?? '…'}</dd>
          </div>
        </dl>
      </section>

      <p className="text-sm text-neutral-500">
        Projects, service cards, and deploy history land in later milestones.
      </p>
    </main>
  );
}
