import { useEffect, useState } from 'react';

export type Route =
  | { name: 'dashboard'; projectId: string | null }
  | { name: 'new-service'; projectId: string | null }
  | { name: 'service'; serviceId: string }
  | { name: 'variables'; serviceId: string }
  | { name: 'not-found'; path: string };

/**
 * Tiny hash router. Deliberate: a routing library is ~10 KB gz against the
 * frontend budget, and these screens need nothing it provides.
 */
export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#/, '') || '/';
  const [path = '/', query = ''] = raw.split('?');
  const params = new URLSearchParams(query);
  const projectId = params.get('project');

  if (path === '/') return { name: 'dashboard', projectId };
  if (path === '/services/new') return { name: 'new-service', projectId };

  const service = /^\/services\/([^/]+)$/.exec(path);
  if (service?.[1]) return { name: 'service', serviceId: service[1] };

  const variables = /^\/services\/([^/]+)\/variables$/.exec(path);
  if (variables?.[1]) return { name: 'variables', serviceId: variables[1] };

  return { name: 'not-found', path };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));

  useEffect(() => {
    const onHashChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  return route;
}

export function navigate(path: string): void {
  window.location.hash = path;
}
