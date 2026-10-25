/**
 * What a repository is, decided from the files GitHub shows us.
 *
 * Detection happens twice and the two are allowed to disagree: here, at create
 * time, to prefill the wizard, and inside the build, where the recipe reports
 * what it actually produced. This file is deliberately pure — a file list and a
 * couple of file bodies in, a decision out — so it can be tested without GitHub
 * and reused by the panel through the API.
 */

export const STRATEGIES = ['dockerfile', 'next', 'static', 'railpack'] as const;
export type Strategy = (typeof STRATEGIES)[number];

/**
 * Values in these names are inlined by the bundler, so they have to exist at build
 * time. One constant, used by the endpoint that selects them and by the panel that
 * tags them, so the two can never drift apart.
 *
 * Names matching `PUBLIC_` are also baked into the artifact. That is accepted and
 * visible — a `build` tag before the deploy, not a blank page after it.
 */
export const BUILD_TIME_PREFIXES = [
  'NEXT_PUBLIC_',
  'VITE_',
  'REACT_APP_',
  'EXPO_PUBLIC_',
  'NUXT_PUBLIC_',
  'PUBLIC_',
] as const;

export function isBuildTimeVariable(name: string): boolean {
  return BUILD_TIME_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** The subset of an environment's variables that a build may see, by name only. */
export function buildTimeVariables(env: Record<string, string>): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (isBuildTimeVariable(key)) selected[key] = value;
  }
  return selected;
}

export interface Detection {
  strategy: Strategy;
  /** `next`, `vite`, `astro`, `go`, … — what the repo looked like, or `unknown`. */
  framework: string;
  /** Directory holding the project — the natural build context. */
  context: string;
  /** Static only; `null` means "the recipe's default". */
  outputDir: string | null;
  /** Static only: serve `index.html` for unknown paths. */
  spaFallback: boolean;
  /** Set only when a Dockerfile won. */
  dockerfilePath?: string;
}

export interface DetectInput {
  /** Every path in the repo at the branch head. */
  paths: string[];
  /** Contents of the root `package.json`, when the repo has one. */
  packageJson?: string | null;
  /** Contents of `next.config.*`, when present. Only `output: 'export'` matters. */
  nextConfig?: string | null;
}

const DOCKERFILE_NAME =
  /^(dockerfile|containerfile)(\.(prod|production|dev|development|ci|test|staging|release|local))?$/i;

const ASTRO_CONFIG = /^astro\.config\.(js|ts|mjs|cjs|mts)$/i;
const VITE_CONFIG = /^vite\.config\.(js|ts|mjs|cjs|mts)$/i;
const NUXT_CONFIG = /^nuxt\.config\.(js|ts|mjs|cjs|mts)$/i;

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

function parsePackageJson(raw: string | null | undefined): PackageJson | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as PackageJson) : null;
  } catch {
    // A package.json we cannot parse is not a reason to refuse: the build will say
    // so with a real error, and Railpack is a fine fallback until then.
    return null;
  }
}

function hasDependency(pkg: PackageJson | null, name: string): boolean {
  return Boolean(pkg?.dependencies?.[name] ?? pkg?.devDependencies?.[name]);
}

const rootFile = (paths: string[], pattern: RegExp) =>
  paths.some((path) => !path.includes('/') && pattern.test(path));

/** `output: 'export'` — the one next.config value that changes the strategy. */
export function isStaticExport(nextConfig: string | null | undefined): boolean {
  if (!nextConfig) return false;
  return /output\s*:\s*['"]export['"]/.test(nextConfig);
}

/**
 * Default output directory per framework. Only used when the user has not set one;
 * the recipe falls back to the same value, so the two agree by construction.
 */
export function defaultOutputDir(framework: string): string {
  switch (framework) {
    case 'next':
      return 'out';
    case 'cra':
      return 'build';
    default:
      return 'dist';
  }
}

/** Unknown paths become `index.html` for client-routed apps, and 404 for static ones. */
export function defaultSpaFallback(framework: string): boolean {
  return framework === 'vite' || framework === 'cra' || framework === 'react';
}

/** Everything we cannot name is still buildable: Railpack detects the language. */
function railpack(framework: string): Detection {
  return {
    strategy: 'railpack',
    framework,
    context: '.',
    outputDir: null,
    spaFallback: false,
  };
}

export function detectFramework(input: DetectInput): Detection {
  const { paths } = input;

  // A Dockerfile is the escape hatch, and it wins over every guess below.
  const dockerfile = paths.find((path) => DOCKERFILE_NAME.test(path.split('/').pop() ?? ''));
  if (dockerfile) {
    const parts = dockerfile.split('/');
    return {
      strategy: 'dockerfile',
      framework: 'dockerfile',
      context: parts.length > 1 ? parts.slice(0, -1).join('/') : '.',
      outputDir: null,
      spaFallback: false,
      dockerfilePath: dockerfile,
    };
  }

  const pkg = parsePackageJson(input.packageJson);
  const dependency = (...names: string[]) => names.some((name) => hasDependency(pkg, name));
  const script = (needle: string) =>
    Object.values(pkg?.scripts ?? {}).some((value) => value.includes(needle));

  if (dependency('next')) {
    const exported = isStaticExport(input.nextConfig);
    return {
      strategy: 'next',
      framework: 'next',
      context: '.',
      outputDir: exported ? 'out' : null,
      spaFallback: false,
    };
  }

  // Nuxt and SvelteKit build servers, not directories: Railpack knows them.
  if (rootFile(paths, NUXT_CONFIG) || dependency('nuxt')) {
    return {
      strategy: 'railpack',
      framework: 'nuxt',
      context: '.',
      outputDir: null,
      spaFallback: false,
    };
  }
  if (dependency('@sveltejs/kit')) {
    return {
      strategy: 'railpack',
      framework: 'sveltekit',
      context: '.',
      outputDir: null,
      spaFallback: false,
    };
  }

  if (rootFile(paths, ASTRO_CONFIG) || dependency('astro')) {
    return {
      strategy: 'static',
      framework: 'astro',
      context: '.',
      outputDir: 'dist',
      spaFallback: false,
    };
  }

  if (rootFile(paths, VITE_CONFIG) || script('vite build') || dependency('vite')) {
    return {
      strategy: 'static',
      framework: 'vite',
      context: '.',
      outputDir: 'dist',
      spaFallback: true,
    };
  }

  if (script('react-scripts build')) {
    return {
      strategy: 'static',
      framework: 'cra',
      context: '.',
      outputDir: 'build',
      spaFallback: true,
    };
  }

  if (paths.includes('go.mod')) return railpack('go');
  if (paths.includes('manage.py')) return railpack('python');
  if (paths.includes('requirements.txt') || paths.includes('pyproject.toml'))
    return railpack('python');
  if (paths.includes('artisan') || paths.includes('composer.json')) return railpack('php');
  if (paths.includes('Gemfile')) return railpack('ruby');

  return railpack('unknown');
}

/** One sentence the panel can show next to the strategy it picked. */
export function strategyLabel(detection: Detection): string {
  switch (detection.strategy) {
    case 'dockerfile':
      return `Dockerfile — ${detection.dockerfilePath ?? 'Dockerfile'}`;
    case 'next':
      return detection.outputDir ? 'Next.js static export' : 'Next.js — optimized build';
    case 'static':
      return `${detection.framework} — files, no container`;
    case 'railpack':
      return detection.framework === 'unknown'
        ? 'Railpack — let the build decide'
        : `Railpack — detected ${detection.framework}`;
  }
}
