/**
 * The workflow nodock commits into a user's repo. It is generic on purpose:
 * every value that changes per build arrives in the repository_dispatch payload,
 * so this file only needs to exist on the default branch once.
 *
 * `repository_dispatch` always runs the workflow from the default branch, and the
 * checkout uses the dispatched SHA — so a build of `feat/x` still builds `feat/x`.
 */
export function renderWorkflow(nodockUrl: string): string {
  const base = nodockUrl.replace(/\/$/, '');

  return `name: nodock
# Managed by nodock. Edits are detected and surfaced in the dashboard; deleting
# this file stops automatic deploys for every service in this repository.

on:
  repository_dispatch:
    types: [nodock-build]

permissions:
  contents: read
  packages: write

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Notify start
        continue-on-error: true
        run: |
          curl -fsS --retry 3 --retry-connrefused --retry-delay 5 \\
            -X POST "${base}/api/ci/started" \\
            -H "Authorization: Bearer \${{ secrets.NODOCK_CI_TOKEN }}" \\
            -H "Content-Type: application/json" \\
            -d '{"buildId":"\${{ github.event.client_payload.buildId }}","repo":"\${{ github.repository }}","runUrl":"\${{ github.server_url }}/\${{ github.repository }}/actions/runs/\${{ github.run_id }}"}'

      - uses: actions/checkout@v4
        with:
          ref: \${{ github.event.client_payload.sha }}

      - uses: docker/setup-buildx-action@v3

      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: \${{ github.actor }}
          password: \${{ secrets.GITHUB_TOKEN }}

      - uses: docker/build-push-action@v6
        id: build
        with:
          context: \${{ github.event.client_payload.context }}
          file: \${{ github.event.client_payload.dockerfile }}
          push: true
          tags: \${{ github.event.client_payload.image }}

      - name: Notify result
        if: always()
        continue-on-error: true
        run: |
          curl -fsS --retry 3 --retry-connrefused --retry-delay 5 \\
            -X POST "${base}/api/ci/finished" \\
            -H "Authorization: Bearer \${{ secrets.NODOCK_CI_TOKEN }}" \\
            -H "Content-Type: application/json" \\
            -d '{"buildId":"\${{ github.event.client_payload.buildId }}","repo":"\${{ github.repository }}","conclusion":"\${{ job.status }}","digest":"\${{ steps.build.outputs.digest }}","runUrl":"\${{ github.server_url }}/\${{ github.repository }}/actions/runs/\${{ github.run_id }}"}'
`;
}

export const WORKFLOW_PATH = '.github/workflows/nodock.yml';
export const CI_SECRET_NAME = 'NODOCK_CI_TOKEN';

/** Immutable image reference: one package per repo, one tag per service+commit. */
export function imageRef(repoFullName: string, serviceSlug: string, sha: string): string {
  const [owner] = repoFullName.toLowerCase().split('/');
  const name = repoFullName.toLowerCase().split('/')[1] ?? '';
  return `ghcr.io/${owner}/${name}:${serviceSlug}-${sha.slice(0, 12).toLowerCase()}`;
}

export interface DispatchPayload {
  buildId: string;
  ref: string;
  sha: string;
  image: string;
  dockerfile: string;
  context: string;
  serviceSlug: string;
}

/** GitHub allows at most 10 top-level properties and 64 KB total. */
export function assertDispatchPayload(payload: DispatchPayload): DispatchPayload {
  const keys = Object.keys(payload);
  if (keys.length > 10)
    throw new Error(`Dispatch payload has ${keys.length} keys, GitHub allows 10`);
  if (JSON.stringify(payload).length > 64 * 1024) throw new Error('Dispatch payload exceeds 64 KB');
  return payload;
}
