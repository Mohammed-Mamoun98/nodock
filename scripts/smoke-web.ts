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
// The only network call the shell makes; answer it locally.
g.fetch = async () =>
  new Response(
    JSON.stringify({ ok: true, database: 'ok', uptimeMs: 1, version: '1.4.2', rssMb: 27, heapUsedMb: 4, sseClients: 0 }),
    { headers: { 'content-type': 'application/json' } },
  );

window.document.body.innerHTML = '<div id="root"></div>';

await import(pathToFileURL(join(assets, entry)).href);
await new Promise((resolve) => setTimeout(resolve, 100));

const root = window.document.getElementById('root');
const html = root?.innerHTML ?? '';

const checks: [string, boolean][] = [
  ['root is populated', html.length > 500],
  ['product mark rendered', html.includes('nodock')],
  ['project switcher rendered', html.includes('milo')],
  ['service card rendered', html.includes('milo-api')],
  ['failure copy names the fix', html.includes('add GHCR_TOKEN')],
  ['ingress node rendered', html.includes('caddy')],
  ['filters rendered', html.includes('Building')],
  ['state vocabulary rendered', html.includes('live')],
];

let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failed += 1;
}

console.log(`\nroot innerHTML: ${html.length} bytes from ${entry}`);
if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('smoke ok');
