import { useState } from 'react';
import { Icon } from '../components/Icon';
import { Button } from '../components/ui';
import { ApiError, deleteProject, deleteService, type ProjectOverview } from '../lib/api';
import { navigate } from '../lib/router';

type Section = 'general' | 'services' | 'danger';

const sections: { id: Section; label: string; icon: 'settings' | 'layers' | 'alert-triangle' }[] = [
  { id: 'general', label: 'General', icon: 'settings' },
  { id: 'services', label: 'Services', icon: 'layers' },
  { id: 'danger', label: 'Danger', icon: 'alert-triangle' },
];

/**
 * Project-scoped settings with its own sub-nav, mirroring Railway. Destructive
 * actions live here rather than in the canvas toolbar, where a stray click is
 * one wrong pixel away from deleting a project.
 */
export function ProjectSettingsPage({
  projectId,
  overview,
  onChanged,
}: {
  projectId: string;
  overview: ProjectOverview | null;
  onChanged: () => void;
}) {
  const [section, setSection] = useState<Section>('general');
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const projectName = overview?.project.name ?? projectId;
  const services = overview?.services ?? [];

  async function removeService(serviceId: string, name: string) {
    setBusy(true);
    setError(null);
    try {
      await deleteService(serviceId);
      onChanged();
    } catch (cause) {
      setError(
        `${name}: ${cause instanceof ApiError ? `${cause.code} · ${cause.message}` : String(cause)}`,
      );
    } finally {
      setBusy(false);
    }
  }

  async function removeProject() {
    setBusy(true);
    setError(null);
    try {
      await deleteProject(projectId);
      navigate('/');
      onChanged();
    } catch (cause) {
      setError(cause instanceof ApiError ? `${cause.code} · ${cause.message}` : String(cause));
      setBusy(false);
    }
  }

  return (
    <main className="flex flex-1 flex-col overflow-hidden bg-canvas">
      <div className="flex items-center gap-2 border-b border-line px-6 py-3">
        <h1 className="text-[18px] font-semibold">Project settings</h1>
        <span className="font-mono text-mono-xs text-text-dim">{projectName}</span>
        <button
          type="button"
          onClick={() => navigate('/')}
          className="ml-auto font-mono text-mono-xs text-text-dim hover:text-text"
        >
          close
        </button>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <nav className="flex w-[220px] shrink-0 flex-col gap-1 border-r border-line p-3">
          {sections.map((entry) => {
            const active = section === entry.id;
            return (
              <button
                key={entry.id}
                type="button"
                onClick={() => setSection(entry.id)}
                aria-current={active ? 'page' : undefined}
                className={`flex h-9 items-center gap-2 rounded px-2 text-left text-ui-sm transition-colors ${
                  active
                    ? 'bg-surface-2 text-text'
                    : entry.id === 'danger'
                      ? 'text-text-dim hover:bg-surface-2/50 hover:text-red'
                      : 'text-text-dim hover:bg-surface-2/50 hover:text-text'
                }`}
              >
                <Icon name={entry.icon} className="h-3.5 w-3.5" />
                {entry.label}
              </button>
            );
          })}
        </nav>

        <div className="flex-1 overflow-y-auto p-8">
          <div className="flex max-w-[620px] flex-col gap-6">
            {error ? (
              <p className="rounded border border-red/30 bg-red/10 px-3 py-2 font-mono text-mono-xs text-red">
                {error}
              </p>
            ) : null}

            {section === 'general' ? (
              <>
                <section className="flex flex-col gap-2">
                  <h2 className="text-ui-lg font-medium">Project</h2>
                  <div className="flex items-center justify-between rounded-md border border-line bg-surface px-3 py-2">
                    <span className="font-mono text-ui-sm">{projectName}</span>
                    <span className="font-mono text-mono-xs text-text-dim">
                      {services.length} service{services.length === 1 ? '' : 's'}
                    </span>
                  </div>
                </section>

                <section className="flex flex-col gap-2">
                  <h2 className="text-ui-lg font-medium">Environments</h2>
                  {(overview?.environments ?? []).map((env) => (
                    <div
                      key={env.id}
                      className="flex items-center justify-between rounded-md border border-line bg-surface px-3 py-2"
                    >
                      <span className="font-mono text-ui-sm">{env.name}</span>
                      <span className="font-mono text-mono-xs text-text-dim">
                        {env.serviceCount} service{env.serviceCount === 1 ? '' : 's'}
                        {env.isDefault ? ' · default' : ''}
                      </span>
                    </div>
                  ))}
                  <p className="font-mono text-mono-xs text-text-dim">
                    Deleting an environment removes its deployments; the default one is protected.
                  </p>
                </section>
              </>
            ) : null}

            {section === 'services' ? (
              <section className="flex flex-col gap-3">
                <h2 className="text-ui-lg font-medium">Manage services</h2>
                <p className="rounded-md border border-red/30 bg-red/5 px-3 py-2 text-ui-sm text-red">
                  <Icon name="alert-triangle" className="mr-1.5 inline h-3 w-3" />
                  Removing a service permanently deletes its deployments and variables in every
                  environment, and stops its container.
                </p>

                {services.length === 0 ? (
                  <p className="font-mono text-mono-xs text-text-dim">
                    No services in this project.
                  </p>
                ) : null}

                <div className="overflow-hidden rounded-md border border-line">
                  {services.map((service) => (
                    <div
                      key={service.id}
                      className="flex items-center justify-between border-b border-line bg-surface px-3 py-2 last:border-b-0"
                    >
                      <a
                        href={`#/services/${service.id}`}
                        className="flex min-w-0 items-center gap-2 hover:text-lime"
                      >
                        <Icon name="github" className="h-3.5 w-3.5 text-text-dim" />
                        <span className="truncate font-mono text-ui-sm">{service.name}</span>
                        <span className="truncate font-mono text-mono-xs text-text-dim">
                          {service.repoFullName}
                        </span>
                      </a>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void removeService(service.id, service.name)}
                        className="shrink-0 rounded border border-red/40 px-2 py-1 text-ui-sm text-red transition-colors hover:bg-red/10 disabled:opacity-40"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            {section === 'danger' ? (
              <section className="flex flex-col gap-3">
                <h2 className="text-ui-lg font-medium">Delete project</h2>
                <p className="rounded-md border border-red/30 bg-red/5 px-3 py-2 text-ui-sm text-red">
                  <Icon name="alert-triangle" className="mr-1.5 inline h-3 w-3" />
                  Deleting the project permanently deletes every service, deployment and variable in
                  it, and stops its containers. This cannot be undone.
                </p>

                <div className="flex flex-wrap items-center gap-2">
                  <input
                    value={confirmText}
                    onChange={(event) => setConfirmText(event.target.value)}
                    placeholder={`type "${projectName}" to confirm`}
                    aria-label="Type the project name to confirm deletion"
                    className="h-9 w-[220px] rounded border border-line bg-surface-2 px-2 font-mono text-mono-xs"
                  />
                  <Button
                    variant="primary"
                    className="border-red bg-red text-canvas hover:bg-red/90"
                    disabled={busy || confirmText.trim() !== projectName}
                    onClick={removeProject}
                  >
                    {busy ? 'Deleting…' : 'Delete project'}
                  </Button>
                </div>
              </section>
            ) : null}
          </div>
        </div>
      </div>
    </main>
  );
}
