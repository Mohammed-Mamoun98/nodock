import { useState } from 'react';
import { Icon } from '../components/Icon';
import { RepoPicker } from '../components/RepoPicker';
import { Button, LinkButton } from '../components/ui';
import { ApiError, createService, listBranches, listRepos, type RepoOption } from '../lib/api';
import { navigate } from '../lib/router';
import { useAsync } from '../lib/useAsync';

const steps = ['Repository', 'Branch', 'Build', 'Variables', 'CI'] as const;

export function NewServicePage({ projectId }: { projectId: string }) {
  const repos = useAsync(() => listRepos(), []);
  const [selected, setSelected] = useState<RepoOption | null>(null);
  const [name, setName] = useState('');
  const [branch, setBranch] = useState('main');
  const [dockerfilePath, setDockerfilePath] = useState('Dockerfile');
  const [contextPath, setContextPath] = useState('.');
  const [containerPort, setContainerPort] = useState('3000');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const branches = useAsync(
    () =>
      selected
        ? listBranches(selected.owner, selected.name)
        : Promise.resolve({ branches: [] as string[] }),
    [selected?.fullName],
  );

  const outsideContext =
    dockerfilePath.startsWith('../') ||
    (contextPath !== '.' && !dockerfilePath.startsWith(`${contextPath}/`));

  const canSubmit =
    Boolean(selected) &&
    name.trim().length > 0 &&
    branch.trim().length > 0 &&
    !outsideContext &&
    !submitting &&
    projectId.length > 0;

  const reposError = repos.error;
  const needsReconnect =
    reposError?.status === 401 ||
    reposError?.code === 'github_token_rejected' ||
    reposError?.code === 'github_not_connected';

  function pick(repo: RepoOption) {
    setSelected(repo);
    setBranch(repo.defaultBranch);
    if (!name.trim()) setName(repo.name);
  }

  async function submit() {
    if (!canSubmit || !selected) return;
    setSubmitting(true);
    setError(null);

    try {
      const created = await createService(projectId, {
        name: name.trim(),
        repoFullName: selected.fullName,
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
                <span className="mb-2 block text-ui-sm">Repository</span>

                {repos.loading && !repos.data ? (
                  <div className="rounded-md border border-line px-3 py-6 text-center font-mono text-mono-xs text-text-dim">
                    loading repositories…
                  </div>
                ) : null}

                {reposError ? (
                  <div className="flex flex-col gap-2 rounded-md border border-red/30 bg-red/5 p-3">
                    <p className="font-mono text-mono-xs text-red">
                      {reposError.code} · {reposError.message}
                    </p>
                    {needsReconnect ? (
                      <a
                        href="/auth/github"
                        className="self-start rounded border border-lime px-2 py-1 text-ui-sm text-lime hover:bg-lime/10"
                      >
                        Reconnect GitHub
                      </a>
                    ) : (
                      <button
                        type="button"
                        onClick={repos.reload}
                        className="self-start rounded border border-line px-2 py-1 text-ui-sm hover:bg-surface-2"
                      >
                        Retry
                      </button>
                    )}
                  </div>
                ) : null}

                {repos.data ? (
                  <RepoPicker
                    repos={repos.data.repos}
                    selected={selected?.fullName ?? null}
                    onSelect={pick}
                    truncated={repos.data.truncated}
                  />
                ) : null}
              </div>

              <div>
                <label htmlFor="service-branch" className="mb-2 block text-ui-sm">
                  Branch
                </label>
                {branches.data && branches.data.branches.length > 0 ? (
                  <select
                    id="service-branch"
                    value={branch}
                    onChange={(event) => setBranch(event.target.value)}
                    className="h-8 w-full rounded-md border border-line bg-surface-2 px-2 font-mono text-ui-sm"
                  >
                    {branches.data.branches.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    id="service-branch"
                    value={branch}
                    onChange={(event) => setBranch(event.target.value)}
                    disabled={!selected}
                    placeholder={selected ? branch : 'pick a repository first'}
                    className="h-8 w-full rounded-md border border-line bg-surface-2 px-3 font-mono text-ui-sm disabled:opacity-50"
                  />
                )}
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
