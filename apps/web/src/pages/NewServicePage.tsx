import { useState } from 'react';
import { Icon } from '../components/Icon';
import { Button, LinkButton } from '../components/ui';
import { ApiError, createService } from '../lib/api';
import { navigate } from '../lib/router';

const steps = ['Repository', 'Branch', 'Build', 'Variables', 'CI'] as const;

export function NewServicePage({ projectId }: { projectId: string }) {
  const [name, setName] = useState('');
  const [repo, setRepo] = useState('');
  const [branch, setBranch] = useState('main');
  const [dockerfilePath, setDockerfilePath] = useState('Dockerfile');
  const [contextPath, setContextPath] = useState('.');
  const [containerPort, setContainerPort] = useState('3000');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const outsideContext =
    dockerfilePath.startsWith('../') ||
    (contextPath !== '.' && !dockerfilePath.startsWith(`${contextPath}/`));

  const repoLooksValid = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo.trim());
  const canSubmit =
    name.trim().length > 0 &&
    repoLooksValid &&
    !outsideContext &&
    !submitting &&
    projectId.length > 0;

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);

    try {
      const created = await createService(projectId, {
        name: name.trim(),
        repoFullName: repo.trim(),
        branch: branch.trim(),
        dockerfilePath,
        contextPath,
        containerPort: Number(containerPort) || undefined,
      });
      navigate(`/services/${created.service.id}`);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause : new ApiError(0, 'network_error', String(cause)));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="relative flex flex-1 flex-col overflow-y-auto bg-canvas dot-grid">
      <div className="mx-auto flex w-full max-w-[720px] flex-col px-6 py-12">
        <div className="mb-8">
          <h1 className="mb-1 text-[20px] font-semibold">New service</h1>
          <p className="text-ui-sm text-text-dim">From a GitHub repository that has a Dockerfile</p>
        </div>

        <div className="flex min-h-[500px] flex-col rounded-lg border border-line bg-surface">
          <div className="flex flex-1 flex-col lg:flex-row">
            <ol className="flex shrink-0 gap-6 border-b border-line p-6 lg:w-[200px] lg:flex-col lg:border-r lg:border-b-0">
              {steps.map((step, index) => {
                const active = index === 0;
                return (
                  <li key={step} className="flex items-start gap-3">
                    <span
                      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full font-mono text-[10px] ${
                        active
                          ? 'border-2 border-lime text-lime'
                          : 'border-2 border-line text-text-dim'
                      }`}
                    >
                      {index + 1}
                    </span>
                    <span
                      className={`mt-0.5 text-ui-sm ${active ? 'font-medium text-lime' : 'text-text-dim'}`}
                    >
                      {step}
                    </span>
                  </li>
                );
              })}
            </ol>

            <div className="flex flex-1 flex-col gap-5 p-8">
              <h2 className="text-ui-lg font-medium">Repository and build</h2>

              <div>
                <label htmlFor="service-name" className="mb-2 block text-ui-sm">
                  Service name
                </label>
                <input
                  id="service-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="milo-api"
                  className="h-8 w-full rounded-md border border-line bg-surface-2 px-3 font-mono text-ui-sm"
                />
              </div>

              <div>
                <label htmlFor="service-repo" className="mb-2 block text-ui-sm">
                  Repository
                </label>
                <input
                  id="service-repo"
                  value={repo}
                  onChange={(event) => setRepo(event.target.value)}
                  placeholder="owner/repo"
                  className="h-8 w-full rounded-md border border-line bg-surface-2 px-3 font-mono text-ui-sm"
                />
                {repo.length > 0 && !repoLooksValid ? (
                  <p className="mt-1.5 font-mono text-mono-xs text-amber">Expected owner/repo</p>
                ) : null}
              </div>

              <div>
                <label htmlFor="service-branch" className="mb-2 block text-ui-sm">
                  Branch
                </label>
                <input
                  id="service-branch"
                  value={branch}
                  onChange={(event) => setBranch(event.target.value)}
                  className="h-8 w-full rounded-md border border-line bg-surface-2 px-3 font-mono text-ui-sm"
                />
              </div>

              <div>
                <label htmlFor="dockerfile-path" className="mb-2 block text-ui-sm">
                  Dockerfile path
                </label>
                <input
                  id="dockerfile-path"
                  value={dockerfilePath}
                  onChange={(event) => setDockerfilePath(event.target.value)}
                  className={`h-8 w-full rounded-md border bg-surface-2 px-3 font-mono text-ui-sm ${
                    outsideContext ? 'border-amber/50' : 'border-line'
                  }`}
                />
                <div className="mt-2 flex items-start gap-1.5">
                  <Icon
                    name="alert-triangle"
                    className={`mt-0.5 ${outsideContext ? 'text-amber' : 'text-text-dim'}`}
                  />
                  <p
                    className={`font-mono text-mono-xs leading-relaxed ${
                      outsideContext ? 'text-amber' : 'text-text-dim'
                    }`}
                  >
                    {outsideContext
                      ? 'A Dockerfile outside the context directory will be rejected by docker build.'
                      : 'Must live inside the build context below.'}
                  </p>
                </div>
              </div>

              <div className="flex gap-4">
                <div className="flex-1">
                  <label htmlFor="context-path" className="mb-2 block text-ui-sm">
                    Context path
                  </label>
                  <input
                    id="context-path"
                    value={contextPath}
                    onChange={(event) => setContextPath(event.target.value)}
                    className="h-8 w-full rounded-md border border-line bg-surface-2 px-3 font-mono text-ui-sm"
                  />
                </div>
                <div className="w-[140px]">
                  <label htmlFor="container-port" className="mb-2 block text-ui-sm">
                    Container port
                  </label>
                  <input
                    id="container-port"
                    value={containerPort}
                    onChange={(event) => setContainerPort(event.target.value)}
                    className="h-8 w-full rounded-md border border-line bg-surface-2 px-3 font-mono text-ui-sm"
                  />
                </div>
              </div>

              {error ? (
                <p className="rounded-md border border-red/30 bg-red/10 px-3 py-2 font-mono text-mono-xs text-red">
                  {error.code} · {error.message}
                </p>
              ) : null}
            </div>
          </div>

          <div className="flex items-center justify-between rounded-b-lg border-t border-line bg-surface-2/30 p-4">
            <LinkButton to="#/" variant="ghost">
              Cancel
            </LinkButton>
            <div className="flex items-center gap-4">
              <span className="font-mono text-mono-xs text-text-dim">step 1 of {steps.length}</span>
              <Button variant="primary" className="px-4" onClick={submit} disabled={!canSubmit}>
                {submitting ? 'Creating…' : 'Create service'}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
