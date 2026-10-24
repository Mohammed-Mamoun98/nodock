/**
 * Repository inspection for the new-service wizard: does this repo actually have a
 * Dockerfile, where is it, and which port does it expose?
 *
 * Pure functions over the file list + file contents, so the wizard's answers are
 * testable without GitHub.
 */

/**
 * Only real variants, not documentation: `docs/dockerfile.md` is a wiki page, and
 * treating it as a build file would offer a context that cannot build.
 */
const DOCKERFILE_NAME =
  /^(dockerfile|containerfile)(\.(prod|production|dev|development|ci|test|staging|release|local))?$/i;

export interface DockerfileCandidate {
  path: string;
  /** Directory containing the Dockerfile — the natural build context. */
  context: string;
  /** Depth in the tree; the shallowest candidate is the best default. */
  depth: number;
}

export function findDockerfiles(paths: string[]): DockerfileCandidate[] {
  return (
    paths
      .filter((path) => {
        const name = path.split('/').pop() ?? '';
        return DOCKERFILE_NAME.test(name);
      })
      .map((path) => {
        const parts = path.split('/');
        return {
          path,
          context: parts.length > 1 ? parts.slice(0, -1).join('/') : '.',
          depth: parts.length,
        };
      })
      // Prefer the shallowest, then alphabetical: root `Dockerfile` wins.
      .toSorted((a, b) => a.depth - b.depth || a.path.localeCompare(b.path))
  );
}

/**
 * Parses `EXPOSE` lines. `8080/tcp` counts, `53/udp` does not — Caddy proxies HTTP.
 */
export function parseExposedPorts(dockerfile: string): number[] {
  const ports = new Set<number>();

  for (const line of dockerfile.split('\n')) {
    const match = /^\s*EXPOSE\s+(.+)$/i.exec(line);
    if (!match?.[1]) continue;

    for (const token of match[1].trim().split(/\s+/)) {
      const part = /^(\d{1,5})(?:\/([a-z]+))?$/i.exec(token);
      if (!part?.[1]) continue;

      const protocol = part[2]?.toLowerCase();
      if (protocol && protocol !== 'tcp') continue;

      const port = Number(part[1]);
      if (port > 0 && port <= 65535) ports.add(port);
    }
  }

  return [...ports].toSorted((a, b) => a - b);
}
