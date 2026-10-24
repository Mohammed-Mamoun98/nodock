/** `Milo API!` → `milo-api`. Stable, lowercase, host-safe. */
export function slugify(input: string, fallback = 'service'): string {
  const slug = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');

  if (!slug) return fallback;
  // Hosts cannot start with a digit-ish label that looks like an IP, and must start with a letter.
  return /^[a-z]/.test(slug) ? slug : `${fallback}-${slug}`;
}

/**
 * Adds -2, -3 … until `taken()` says the value is free. Two services called
 * "web" in different projects therefore get distinct hosts, not a 500.
 */
export function uniqueValue(base: string, taken: (candidate: string) => boolean): string {
  if (!taken(base)) return base;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken(candidate)) return candidate;
  }
  throw new Error(`Unable to find a free name for ${base}`);
}

/**
 * `<service>.<base>` in the default environment, `<service>-<env>.<base>` elsewhere.
 * Mirrors the plan's host rules so routing and TLS can key off one function.
 */
export function generatedHost(serviceSlug: string, envSlug: string, baseDomain: string): string {
  const label = envSlug === 'production' ? serviceSlug : `${serviceSlug}-${envSlug}`;
  return `${label}.${baseDomain}`.toLowerCase();
}
