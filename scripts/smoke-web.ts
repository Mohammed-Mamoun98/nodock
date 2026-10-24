/**
 * Renders the PRODUCTION bundle in a happy-dom window. This is the only check that
 * proves the Preact alias works: tsc validates against React types, so a broken
 * `react-dom` → `preact/compat` mapping would still typecheck and still build.
 *
 *   bun scripts/smoke-web.ts
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';

const dist = join(import.meta.dir, '../apps/web/dist');
const assets = join(dist, 'assets');
const entry = readdirSync(assets).find((file) => file.endsWith('.js'));

if (!entry) {
  console.error('No built JS found. Run `bun run build:web` first.');
  process.exit(1);
}

const window = new Window({ url: 'http://localhost/' });
const g = globalThis as unknown as Record<string, unknown>;

g.window = window;
g.document = window.document;
g.location = window.location;
g.history = window.history;
g.navigator = window.navigator;
g.HTMLElement = window.HTMLElement;
g.Element = window.Element;
g.Node = window.Node;
g.Event = window.Event;
g.CustomEvent = window.CustomEvent;
g.KeyboardEvent = window.KeyboardEvent;
g.getComputedStyle = window.getComputedStyle.bind(window);
g.requestAnimationFrame = (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 0);
g.cancelAnimationFrame = (id: number) => clearTimeout(id);
// The only calls the shell makes; answer them locally.
const anonymous = process.env.SMOKE_ANONYMOUS === '1';

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

g.fetch = async (input: string | URL | Request) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.includes('/api/me')) {
    if (anonymous) return new Response(null, { status: 401 });
    return json({
      login: 'mohammed',
      avatarUrl: null,
      scopes: ['repo', 'workflow'],
      missingScopes: [],
      needsReconnect: false,
    });
  }

  // Signed-in shell fetches: project list, then the project overview.
  if (url.includes('/api/projects/p1')) {
    return json({
      project: { id: 'p1', name: 'milo', slug: 'milo' },
      environments: [
        { id: 'e1', name: 'Production', slug: 'production', isDefault: true, serviceCount: 1 },
      ],
      services: [
        {
          id: 's1',
          name: 'milo-api',
          slug: 'milo-api',
          repoFullName: 'mohammed/milo',
          dockerfilePath: 'Dockerfile',
          contextPath: '.',
          containerPort: 3000,
          memoryLimitMb: null,
          serviceEnvs: [
            {
              id: 'se1',
              environmentId: 'e1',
              branch: 'main',
              healthPath: '/healthz',
              generatedHost: 'milo-api.apps.localhost',
              customDomain: null,
              latestDeployment: {
                id: 'd1',
                status: 'live',
                trigger: 'push',
                commitSha: 'a3f9c21',
                ciRunUrl: null,
                error: null,
                createdAt: new Date().toISOString(),
              },
            },
          ],
        },
      ],
    });
  }

  if (url.includes('/api/projects')) {
    return json({
      projects: [{ id: 'p1', name: 'milo', slug: 'milo', serviceCount: 1 }],
    });
  }

  return json({
    ok: true,
    database: 'ok',
    uptimeMs: 1,
    version: '1.4.2',
    rssMb: 27,
    heapUsedMb: 4,
    sseClients: 0,
  });
};

window.document.body.innerHTML = '<div id="root"></div>';

await import(pathToFileURL(join(assets, entry)).href);
// The shell resolves /api/me before it renders anything, so wait for that round trip.
await new Promise((resolve) => setTimeout(resolve, 250));

const root = window.document.getElementById('root');
const html = root?.innerHTML ?? '';

const checks: [string, boolean][] = anonymous
  ? [
      ['login gate rendered', html.includes('Continue with GitHub')],
      ['requested scopes disclosed', html.includes('repo · workflow')],
      ['no dashboard leaked to anonymous users', !html.includes('milo-api')],
    ]
  : [
      ['root is populated', html.length > 500],
      ['product mark rendered', html.includes('nodock')],
      ['project switcher rendered', html.includes('milo')],
      ['service card rendered', html.includes('milo-api')],
      ['real host rendered', html.includes('milo-api.apps.localhost')],
      ['deployment state rendered', html.includes('live')],
      ['filters rendered', html.includes('Building')],
      ['state vocabulary rendered', html.includes('live')],
      ['sign out affordance rendered', html.includes('sign out')],
    ];

let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failed += 1;
}

console.log(
  `\nroot innerHTML: ${html.length} bytes from ${entry} (${anonymous ? 'anonymous' : 'signed in'})`,
);
if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('smoke ok');
