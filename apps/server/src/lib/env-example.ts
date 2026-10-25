/**
 * What does this repo expect to be installed as environment variables?
 *
 * Read out of the files people actually keep in their repos — `.env.example` and its
 * cousins — so the panel can offer the names instead of making the user retype them.
 *
 * Pure functions over a file list and a file body: no GitHub, no I/O, testable on its own.
 * Values are deliberately never returned. A placeholder like `sk_test_xxxx` is not a
 * secret and is not a default; the name is the useful part.
 */

/** Only real templates: a checked-in `.env` is someone's actual secrets, not a spec. */
const ENV_TEMPLATE = /^\.env\.(example|sample|template|dist|defaults)$/i;

/** Keys must survive a shell and the variables table; anything else is not a name. */
const VALID_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Credential-shaped name segments. Matched per underscore-separated segment, so
 * `MONKEY` is not a `KEY` and `PUBLIC_URL` stays plain — but `APIKEY` (no separator)
 * still counts, because it is one word people really write.
 */
const SECRET_SEGMENTS = new Set([
  'SECRET',
  'SECRETS',
  'TOKEN',
  'KEY',
  'APIKEY',
  'PASSWORD',
  'PASSWD',
  'PASS',
  'PWD',
  'DSN',
  'SALT',
  'AUTH',
  'PRIVATE',
  'CREDENTIAL',
  'CREDENTIALS',
]);

/** Never worth scanning: vendored code ships other people's example files. */
const SKIP_DIRS = /(^|\/)(node_modules|vendor|\.git)\//;

export interface EnvKey {
  key: string;
  /** The comment block directly above the line, joined — usually the only docs there is. */
  comment: string | null;
}

/** Shallowest first: a root template is the repo's intent, a nested one may be a sub-package. */
export function findEnvFiles(paths: string[]): string[] {
  return paths
    .filter((path) => !SKIP_DIRS.test(path))
    .filter((path) => {
      const name = path.split('/').pop() ?? '';
      return ENV_TEMPLATE.test(name);
    })
    .toSorted((a, b) => {
      const depth = a.split('/').length - b.split('/').length;
      return depth || a.localeCompare(b);
    });
}

export function parseEnvKeys(text: string): EnvKey[] {
  const seen = new Set<string>();
  const keys: EnvKey[] = [];
  let comment: string[] = [];

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();

    if (line.length === 0) {
      comment = [];
      continue;
    }

    if (line.startsWith('#')) {
      const body = line.replace(/^#+\s*/, '');
      // A commented-out assignment is a disabled variable, not documentation — and quoting
      // it would leak the placeholder value into the panel. It also ends the block.
      if (/^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/.test(body)) {
        comment = [];
        continue;
      }
      comment.push(body);
      continue;
    }

    const match = /^(?:export\s+)?([^=\s]+)\s*=/.exec(line);
    if (!match?.[1]) {
      // A bare word, or junk: not an assignment, and it breaks the comment block either way.
      comment = [];
      continue;
    }

    const key = match[1];
    if (!VALID_KEY.test(key) || seen.has(key)) continue;

    seen.add(key);
    keys.push({ key, comment: comment.length > 0 ? comment.join(' ').trim() : null });
    comment = [];
  }

  return keys;
}

export function looksSecret(name: string): boolean {
  return name
    .toUpperCase()
    .split('_')
    .some((segment) => SECRET_SEGMENTS.has(segment));
}
