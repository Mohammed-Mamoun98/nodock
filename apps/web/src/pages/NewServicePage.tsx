import { useState } from 'react';
import { FrameworkIcon } from '../components/FrameworkIcon';
import { Icon } from '../components/Icon';
import { RepoPicker } from '../components/RepoPicker';
import { Button, LinkButton } from '../components/ui';
import {
  ApiError,
  createService,
  enableCi,
  getCiStatus,
  inspectRepo,
  listBranches,
  listRepos,
  type CiState,
  type RepoInspection,
  type RepoOption,
} from '../lib/api';
import { navigate } from '../lib/router';
import { useAsync } from '../lib/useAsync';

const steps = ['Repository', 'Branch', 'Build', 'Variables', 'CI'] as const;

export function NewServicePage({ projectId }: { projectId: string }) {
  const repos = useAsync(() => listRepos(), []);
  const [selected, setSelected] = useState<RepoOption | null>(null);
  const [name, setName] = useState('');
  const [branch, setBranch] = useState('main');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  // Values the operator typed win over anything we detected.
  const [dockerfileOverride, setDockerfileOverride] = useState<string | null>(null);
  const [contextOverride, setContextOverride] = useState<string | null>(null);
  const [portOverride, setPortOverride] = useState<string | null>(null);
  const [strategyOverride, setStrategyOverride] = useState<'auto' | 'dockerfile'>('auto');
  const [outputDirOverride, setOutputDirOverride] = useState<string | null>(null);
  /** null = follow detection: on while CI is missing, off once it is enabled. */
  const [ciChoice, setCiChoice] = useState<boolean | null>(null);

  const owner = selected?.owner ?? '';
  const repo = selected?.name ?? '';

  const branches = useAsync(
    () => (selected ? listBranches(owner, repo) : Promise.resolve({ branches: [] as string[] })),
    [owner, repo],
  );

  const inspection = useAsync<RepoInspection | null>(
    () => (selected ? inspectRepo(owner, repo, branch) : Promise.resolve(null)),
    [owner, repo, branch],
  );

  const ci = useAsync<CiState | null>(
    () => (selected ? getCiStatus(owner, repo) : Promise.resolve(null)),
    [owner, repo],
  );

  const detection = inspection.data;
  const dockerfilePath = dockerfileOverride ?? detection?.dockerfilePath ?? 'Dockerfile';
  const contextPath = contextOverride ?? detection?.contextPath ?? '.';
  const containerPort =
    portOverride ?? (detection?.suggestedPort ? String(detection.suggestedPort) : '3000');

  const ciEnabled = ci.data?.status === 'enabled';
  const enableCiOnCreate = ciChoice ?? !ciEnabled;

  const outsideContext =
    dockerfilePath.startsWith('../') ||
    (contextPath !== '.' && !dockerfilePath.startsWith(`${contextPath}/`));

  // What the repo looked like, and therefore what the build will do with it. The
  // Dockerfile stays available: detection is a suggestion, never a gate.
  const detected = detection?.detection ?? null;
  const strategy =
    strategyOverride === 'dockerfile' ? 'dockerfile' : (detected?.strategy ?? 'dockerfile');
  const isDockerfile = strategy === 'dockerfile';
  const needsOutputDir = detected?.outputDir !== null && detected?.outputDir !== undefined;
  const outputDir =
    outputDirOverride ?? detected?.outputDir ?? (strategy === 'static' ? 'dist' : '');
  const noDockerfile = detection !== null && !detection.hasDockerfile;

  const canSubmit =
    Boolean(selected) &&
    name.trim().length > 0 &&
    branch.trim().length > 0 &&
    (isDockerfile ? !outsideContext : true) &&
    !inspection.loading &&
    !submitting;

  function pick(option: RepoOption) {
    setSelected(option);
    setBranch(option.defaultBranch);
    setDockerfileOverride(null);
    setContextOverride(null);
    setPortOverride(null);
    setStrategyOverride('auto');
    setOutputDirOverride(null);
    if (!name.trim()) setName(option.name);
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
        strategy,
        outputDir: needsOutputDir ? outputDir : null,
        spaFallback: detected?.spaFallback ?? null,
      });

      // Enable CI here rather than making the operator find the panel later. A
      // failure is not fatal: the service page shows the CI banner with the reason.
      if (enableCiOnCreate && !ciEnabled) {
        await enableCi(owner, repo, false).catch(() => undefined);
      }

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

                {repos.error ? (
                  <div className="flex flex-col gap-2 rounded-md border border-red/30 bg-red/5 p-3">
                    <p className="font-mono text-mono-xs text-red">
                      {repos.error.code} · {repos.error.message}
                    </p>
                    {repos.error.status === 401 || repos.error.code === 'github_token_rejected' ? (
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

              {selected ? (
                <div className="flex items-start gap-3 rounded-md border border-line bg-surface-2/40 px-3 py-2 font-mono text-mono-xs">
                  {/* The mark says which technology at a glance; the lines say what
                      the build will do with it. Empty until there is a verdict. */}
                  <span
                    className="mt-px flex h-6 w-6 shrink-0 items-center justify-center rounded border border-line bg-surface text-text-dim"
                    title={detected ? detected.framework : undefined}
                  >
                    <FrameworkIcon framework={detected?.framework} className="h-4 w-4" />
                  </span>

                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    {inspection.loading ? (
                      <span className="text-text-dim">inspecting repository…</span>
                    ) : null}

                    {inspection.error ? (
                      <span className="text-red">inspect failed · {inspection.error.message}</span>
                    ) : null}

                    {noDockerfile && detected ? (
                      <>
                        <span className="flex items-center gap-1.5 text-lime">
                          <Icon name="check" className="h-3 w-3" />
                          no Dockerfile needed
                        </span>
                        <span className="text-text-dim">{detected.label}</span>
                      </>
                    ) : null}

                    {detection?.hasDockerfile ? (
                      <div className="flex flex-col gap-1 text-text-dim">
                        <span className="text-lime">
                          ✓ {detection.dockerfilePath}
                          {detection.contextPath && detection.contextPath !== '.'
                            ? ` · context ${detection.contextPath}`
                            : ''}
                        </span>
                        <span>
                          {detection.exposedPorts.length > 0
                            ? `EXPOSE ${detection.exposedPorts.join(', ')}`
                            : 'no EXPOSE in the Dockerfile — set the port your app listens on'}
                        </span>
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}

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
                    className="h-8 w-full rounded-md border border-line bg-surface-2 px-3 font-mono text-ui-sm disabled:opacity-50"
                  />
                )}
              </div>

              <div>
                <label htmlFor="strategy" className="mb-2 block text-ui-sm">
                  Build
                </label>
                <select
                  id="strategy"
                  value={strategyOverride === 'dockerfile' ? 'dockerfile' : 'auto'}
                  onChange={(event) => {
                    setStrategyOverride(
                      event.target.value === 'dockerfile' ? 'dockerfile' : 'auto',
                    );
                    setDockerfileOverride(null);
                  }}
                  disabled={!selected}
                  className="h-8 w-full rounded-md border border-line bg-surface-2 px-2 font-mono text-ui-sm disabled:opacity-50"
                >
                  <option value="auto">
                    Auto — {detected ? detected.label : 'decide from the repository'}
                  </option>
                  <option value="dockerfile">Dockerfile — build it myself</option>
                </select>
                <p className="mt-2 font-mono text-mono-xs leading-relaxed text-text-dim">
                  {isDockerfile
                    ? 'The build uses this Dockerfile. Nothing else is guessed.'
                    : strategy === 'static'
                      ? 'The build produces files and Caddy serves them. No container, no port.'
                      : 'The build runs in GitHub Actions and reports what it produced.'}
                </p>
              </div>

              {isDockerfile ? (
                <>
                  <div>
                    <label htmlFor="dockerfile-path" className="mb-2 block text-ui-sm">
                      Dockerfile path
                    </label>
                    <input
                      id="dockerfile-path"
                      value={dockerfilePath}
                      onChange={(event) => setDockerfileOverride(event.target.value)}
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
                          : 'Prefilled from the repository. Must live inside the build context below.'}
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
                        onChange={(event) => setContextOverride(event.target.value)}
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
                        onChange={(event) => setPortOverride(event.target.value)}
                        className="h-8 w-full rounded-md border border-line bg-surface-2 px-3 font-mono text-ui-sm"
                      />
                    </div>
                  </div>
                  <p className="-mt-3 font-mono text-mono-xs text-text-dim">
                    {detection?.suggestedPort
                      ? 'from EXPOSE in the Dockerfile — must be the port the process binds to 0.0.0.0'
                      : 'the port your app listens on inside the container (default 3000)'}
                  </p>
                </>
              ) : needsOutputDir ? (
                <div className="flex gap-4">
                  <div className="flex-1">
                    <label htmlFor="output-dir" className="mb-2 block text-ui-sm">
                      Output directory
                    </label>
                    <input
                      id="output-dir"
                      value={outputDir}
                      onChange={(event) => setOutputDirOverride(event.target.value)}
                      className="h-8 w-full rounded-md border border-line bg-surface-2 px-3 font-mono text-ui-sm"
                    />
                    <p className="mt-2 font-mono text-mono-xs text-text-dim">
                      the build fails if it produces nothing here
                    </p>
                  </div>
                </div>
              ) : (
                <div className="w-[140px]">
                  <label htmlFor="container-port" className="mb-2 block text-ui-sm">
                    Container port
                  </label>
                  <input
                    id="container-port"
                    value={containerPort}
                    onChange={(event) => setPortOverride(event.target.value)}
                    className="h-8 w-full rounded-md border border-line bg-surface-2 px-3 font-mono text-ui-sm"
                  />
                </div>
              )}

              <label className="flex items-start gap-2 rounded-md border border-line bg-surface-2/40 px-3 py-2">
                <input
                  type="checkbox"
                  checked={enableCiOnCreate}
                  onChange={(event) => setCiChoice(event.target.checked)}
                  disabled={ciEnabled}
                  className="mt-0.5"
                />
                <span className="flex flex-col gap-0.5">
                  <span className="text-ui-sm">Enable CI for this repository</span>
                  <span className="font-mono text-mono-xs text-text-dim">
                    {ciEnabled
                      ? 'already enabled'
                      : 'commits .github/workflows/nodock.yml and an Actions secret'}
                  </span>
                </span>
              </label>

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
