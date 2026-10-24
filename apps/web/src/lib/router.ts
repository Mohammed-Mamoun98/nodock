import { useEffect, useState } from 'react';

export type Route =
  | { name: 'dashboard' }
  | { name: 'new-service' }
  | { name: 'service'; serviceId: string }
  | { name: 'variables'; serviceId: string }
  | { name: 'not-found'; path: string };

/**
 * Tiny hash router. Deliberate: a routing library is ~10 KB gz against a 120 KB
 * budget, and these four screens need nothing it provides yet.
 */
export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, '') || '/';

  if (path === '/') return { name: 'dashboard' };
  if (path === '/services/new') return { name: 'new-service' };

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

export function href(path: string): string {
  return `#${path}`;
}
