import type { Config } from '../config';

/**
 * Explains a failed `docker pull` in words that name the fix. Docker's raw text
 * ("error from registry: unauthorized unauthorized") is accurate and useless.
 */
export function explainPullFailure(error: string, config: Config): string {
  const raw = error.trim().slice(0, 300);
  const denied = /unauthorized|denied|authentication required|\b401\b/i.test(error);

  if (!denied) return raw;

  if (config.ghcr.token) {
    return [
      'GHCR denied the pull even though GHCR_TOKEN is set.',
      'The token needs `read:packages`, and the package must grant that account access',
      '(org packages often need "Manage Actions access" or an SSO authorisation).',
      `→ ${raw}`,
    ].join(' ');
  }

  return [
    'The GHCR package is private and nodock pulled anonymously.',
    'Either make the package public, or set GHCR_USER + GHCR_TOKEN (classic PAT, `read:packages`).',
    `→ ${raw}`,
  ].join(' ');
}
