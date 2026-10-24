import { useState } from 'react';
import { Icon } from '../components/Icon';
import { Button, LinkButton } from '../components/ui';

const steps = ['Repository', 'Branch', 'Build', 'Variables', 'CI'] as const;
const current = 3;

export function NewServicePage() {
  const [dockerfilePath, setDockerfilePath] = useState('Dockerfile');
  const [contextPath, setContextPath] = useState('.');
  const [containerPort, setContainerPort] = useState('3000');

  const outsideContext =
    dockerfilePath.startsWith('../') ||
    (contextPath !== '.' && !dockerfilePath.startsWith(`${contextPath}/`));

  return (
    <main className="relative flex flex-1 flex-col overflow-y-auto bg-canvas dot-grid">
      <div className="mx-auto flex w-full max-w-[720px] flex-col px-6 py-12">
        <div className="mb-8">
          <h1 className="mb-1 text-[20px] font-semibold">New service</h1>
          <p className="text-ui-sm text-text-dim">From a GitHub repository that has a Dockerfile</p>
        </div>

        <div className="flex min-h-[500px] flex-col rounded-lg border border-line bg-surface">
          <div className="flex flex-1 flex-col sm:flex-row">
            <ol className="flex shrink-0 gap-6 border-b border-line p-6 sm:w-[200px] sm:flex-col sm:border-r sm:border-b-0">
              {steps.map((step, index) => {
                const number = index + 1;
                const done = number < current;
                const active = number === current;
                return (
                  <li key={step} className="flex items-start gap-3">
                    <span
                      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full font-mono text-[10px] ${
                        done
                          ? 'bg-lime text-lime-ink'
                          : active
                            ? 'border-2 border-lime text-lime'
                            : 'border-2 border-line text-text-dim'
                      }`}
                    >
                      {done ? <Icon name="check" className="h-3 w-3" /> : number}
                    </span>
                    <span
                      className={`mt-0.5 text-ui-sm ${
                        active
                          ? 'font-medium text-lime'
                          : done
                            ? 'font-medium text-text'
                            : 'text-text-dim'
                      }`}
                    >
                      {step}
                    </span>
                  </li>
                );
              })}
            </ol>

            <div className="flex flex-1 flex-col p-8">
              <h2 className="mb-6 text-ui-lg font-medium">Build configuration</h2>

              <div className="flex flex-col gap-6">
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

                <div>
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

                <div>
                  <label htmlFor="container-port" className="mb-2 block text-ui-sm">
                    Container port
                  </label>
                  <input
                    id="container-port"
                    value={containerPort}
                    onChange={(event) => setContainerPort(event.target.value)}
                    className="h-8 w-full rounded-md border border-line bg-surface-2 px-3 font-mono text-ui-sm"
                  />
                  <p className="mt-2 font-mono text-mono-xs text-text-dim">
                    Caddy routes to this port inside the container. No host ports are published.
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between rounded-b-lg border-t border-line bg-surface-2/30 p-4">
            <LinkButton to="#/" variant="ghost">
              Back
            </LinkButton>
            <div className="flex items-center gap-4">
              <span className="font-mono text-mono-xs text-text-dim">
                step {current} of {steps.length}
              </span>
              <Button variant="primary" className="px-4" disabled={outsideContext}>
                Continue
              </Button>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
