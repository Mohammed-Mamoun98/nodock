export interface ContainerSpec {
  name: string;
  image: string;
  /** Written to a 0600 file, never argv: `docker inspect` would leak argv to any local user. */
  envFile: string;
  network: string;
  memoryMb: number;
  labels: Record<string, string>;
  pidsLimit?: number;
  stopGraceSeconds?: number;
}

export interface PullResult {
  ok: boolean;
  error?: string;
}

export interface ContainerState {
  running: boolean;
  exitCode: number | null;
  status: string;
}

export interface DockerAdapter {
  /** Daemon reachable? Returns the server version. */
  ping?(): Promise<string>;
  /** `docker login` against a registry, token passed on stdin (never argv). */
  login?(registry: string, username: string, token: string): Promise<void>;
  networkExists?(name: string): Promise<boolean>;
  pull(image: string, onLine: (line: string) => void): Promise<PullResult>;
  run(spec: ContainerSpec): Promise<{ id: string }>;
  inspect(name: string): Promise<ContainerState | null>;
  stop(name: string, graceSeconds: number): Promise<void>;
  remove(name: string): Promise<void>;
}

/**
 * Pure arg builder so the exact `docker run` invocation is snapshot-testable.
 * Notably absent: `-p`. App containers publish nothing; Caddy reaches them by
 * container name on the shared network.
 */
export function buildRunArgs(spec: ContainerSpec): string[] {
  const args = [
    'run',
    '-d',
    '--name',
    spec.name,
    '--network',
    spec.network,
    '--restart',
    'unless-stopped',
    '--memory',
    `${spec.memoryMb}m`,
    '--pids-limit',
    String(spec.pidsLimit ?? 256),
    '--stop-timeout',
    String(spec.stopGraceSeconds ?? 15),
    '--log-opt',
    'max-size=10m',
    '--log-opt',
    'max-file=3',
  ];

  for (const [key, value] of Object.entries(spec.labels).toSorted(([a], [b]) =>
    a.localeCompare(b),
  )) {
    args.push('--label', `${key}=${value}`);
  }

  args.push('--env-file', spec.envFile, spec.image);
  return args;
}

/** Deterministic container name: readable in `docker ps`, unique per deployment. */
export function containerName(serviceSlug: string, envSlug: string, deploymentId: string): string {
  return `nodock-${serviceSlug}-${envSlug}-${deploymentId.slice(0, 8)}`.toLowerCase();
}

export function assertSafeContainerName(name: string): string {
  if (!/^[a-z0-9][a-z0-9_.-]{0,62}$/.test(name)) {
    throw new Error(`Unsafe container name: ${JSON.stringify(name)}`);
  }
  return name;
}

export function createDockerCli(run: typeof Bun.spawn = Bun.spawn): DockerAdapter {
  async function exec(args: string[], onStderr?: (line: string) => void): Promise<number> {
    const child = run(['docker', ...args], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });

    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    const [out, err] = await Promise.all([stdout, stderr]);
    const code = await child.exited;

    if (onStderr) {
      for (const line of (err + out).split('\n')) {
        if (line.trim()) onStderr(line.trim());
      }
    }

    return code;
  }

  return {
    async ping() {
      const child = run(['docker', 'version', '--format', '{{.Server.Version}}'], {
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'ignore',
      });
      const [out, err] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      const code = await child.exited;
      if (code !== 0) {
        throw new Error((err || out).trim().split('\n')[0] || 'docker daemon unreachable');
      }
      return out.trim();
    },

    async login(registry, username, token) {
      const child = run(['docker', 'login', registry, '--username', username, '--password-stdin'], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });

      child.stdin.write(`${token}\n`);
      child.stdin.end();

      const [out, err] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      const code = await child.exited;

      if (code !== 0) {
        throw new Error(`docker login ${registry} failed: ${(err || out).trim().slice(0, 200)}`);
      }
    },

    async networkExists(name) {
      const code = await exec(['network', 'inspect', name]);
      return code === 0;
    },

    async pull(image, onLine) {
      const child = run(['docker', 'pull', image], { stdout: 'pipe', stderr: 'pipe' });

      const decoder = new TextDecoder();
      for await (const chunk of child.stdout) {
        for (const line of decoder.decode(chunk).split('\n')) {
          if (line.trim()) onLine(line.trim());
        }
      }

      const stderr = await new Response(child.stderr).text();
      const code = await child.exited;

      if (code !== 0) {
        const detail = stderr.trim() || `docker pull exited with ${code}`;
        onLine(detail);
        return { ok: false, error: detail };
      }
      return { ok: true };
    },

    async run(spec) {
      assertSafeContainerName(spec.name);
      const child = run(['docker', ...buildRunArgs(spec)], {
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'ignore',
      });

      const [out, err] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      const code = await child.exited;

      if (code !== 0) throw new Error(`docker run failed: ${(err || out).trim().slice(0, 300)}`);
      return { id: out.trim() };
    },

    async inspect(name) {
      const child = run(
        [
          'docker',
          'inspect',
          '--format',
          '{{.State.Running}} {{.State.ExitCode}} {{.State.Status}}',
          name,
        ],
        { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' },
      );

      const out = await new Response(child.stdout).text();
      const code = await child.exited;
      if (code !== 0) return null;

      const [running, exitCode, status] = out.trim().split(' ');
      return {
        running: running === 'true',
        exitCode: exitCode === '<no value>' ? null : Number(exitCode),
        status: status ?? 'unknown',
      };
    },

    async stop(name, graceSeconds) {
      await exec(['stop', '-t', String(graceSeconds), name]);
    },

    async remove(name) {
      await exec(['rm', '-f', name]);
    },
  };
}
