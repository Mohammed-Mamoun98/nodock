import { describe, expect, test } from 'bun:test';
import {
  BUILD_TIME_PREFIXES,
  buildTimeVariables,
  defaultOutputDir,
  detectFramework,
  isBuildTimeVariable,
  isStaticExport,
  strategyLabel,
} from '../src/lib/framework';

const pkg = (value: Record<string, unknown>) => JSON.stringify(value);

describe('detectFramework', () => {
  test('a Dockerfile wins over everything else', () => {
    const detection = detectFramework({
      paths: ['Dockerfile', 'package.json', 'next.config.ts'],
      packageJson: pkg({ dependencies: { next: '15.0.0' } }),
    });

    expect(detection.strategy).toBe('dockerfile');
    expect(detection.dockerfilePath).toBe('Dockerfile');
    expect(detection.context).toBe('.');
  });

  test('a Dockerfile in a subdirectory brings its own context', () => {
    const detection = detectFramework({ paths: ['apps/api/Dockerfile', 'README.md'] });
    expect(detection.strategy).toBe('dockerfile');
    expect(detection.context).toBe('apps/api');
  });

  test('documentation named like a Dockerfile is not one', () => {
    const detection = detectFramework({ paths: ['docs/dockerfile.md', 'go.mod'] });
    expect(detection.strategy).toBe('railpack');
    expect(detection.framework).toBe('go');
  });

  test('Next is its own strategy, with no output directory', () => {
    const detection = detectFramework({
      paths: ['package.json', 'next.config.ts'],
      packageJson: pkg({ dependencies: { next: '15.0.0' }, devDependencies: { vite: '6.0.0' } }),
    });

    expect(detection.strategy).toBe('next');
    expect(detection.framework).toBe('next');
    expect(detection.outputDir).toBeNull();
    expect(detection.spaFallback).toBe(false);
  });

  test('Next with output: export is a static export', () => {
    const detection = detectFramework({
      paths: ['package.json', 'next.config.mjs'],
      packageJson: pkg({ dependencies: { next: '15.0.0' } }),
      nextConfig: "const nextConfig = { output: 'export' };\nexport default nextConfig;\n",
    });

    expect(detection.strategy).toBe('next');
    expect(detection.outputDir).toBe('out');
  });

  test('isStaticExport only matches a real output declaration', () => {
    expect(isStaticExport('output: "export"')).toBe(true);
    expect(isStaticExport('output: "standalone"')).toBe(false);
    expect(isStaticExport(null)).toBe(false);
    // The comment is a false positive we accept: a config we cannot execute is
    // still better read than ignored, and the build reports the truth either way.
    expect(isStaticExport("// output: 'export' was removed")).toBe(true);
  });

  test('Vite is served as files with an SPA fallback', () => {
    const detection = detectFramework({
      paths: ['package.json', 'vite.config.ts'],
      packageJson: pkg({ devDependencies: { vite: '6.0.0' } }),
    });

    expect(detection.strategy).toBe('static');
    expect(detection.framework).toBe('vite');
    expect(detection.outputDir).toBe('dist');
    expect(detection.spaFallback).toBe(true);
  });

  test('a build script is enough without a config file', () => {
    const detection = detectFramework({
      paths: ['package.json'],
      packageJson: pkg({ scripts: { build: 'vite build --mode production' } }),
    });
    expect(detection.strategy).toBe('static');
    expect(detection.framework).toBe('vite');
  });

  test('Astro is static without an SPA fallback', () => {
    const detection = detectFramework({ paths: ['package.json', 'astro.config.mjs'] });
    expect(detection.strategy).toBe('static');
    expect(detection.framework).toBe('astro');
    expect(detection.spaFallback).toBe(false);
  });

  test('create-react-app builds to build/', () => {
    const detection = detectFramework({
      paths: ['package.json'],
      packageJson: pkg({ scripts: { build: 'react-scripts build' } }),
    });
    expect(detection.strategy).toBe('static');
    expect(detection.framework).toBe('cra');
    expect(detection.outputDir).toBe('build');
  });

  test('Nuxt goes to Railpack even though it has a vite-shaped config', () => {
    const detection = detectFramework({
      paths: ['package.json', 'nuxt.config.ts', 'vite.config.ts'],
      packageJson: pkg({ dependencies: { nuxt: '3.14.0' } }),
    });
    expect(detection.strategy).toBe('railpack');
    expect(detection.framework).toBe('nuxt');
  });

  test('SvelteKit goes to Railpack', () => {
    const detection = detectFramework({
      paths: ['package.json'],
      packageJson: pkg({ devDependencies: { '@sveltejs/kit': '2.0.0', vite: '6.0.0' } }),
    });
    expect(detection.strategy).toBe('railpack');
    expect(detection.framework).toBe('sveltekit');
  });

  test('language markers all land on Railpack', () => {
    const cases: [string[], string][] = [
      [['go.mod', 'main.go'], 'go'],
      [['requirements.txt'], 'python'],
      [['pyproject.toml'], 'python'],
      [['manage.py'], 'python'],
      [['composer.json'], 'php'],
      [['artisan'], 'php'],
      [['Gemfile'], 'ruby'],
    ];

    for (const [paths, framework] of cases) {
      expect(detectFramework({ paths }).framework).toBe(framework);
      expect(detectFramework({ paths }).strategy).toBe('railpack');
    }
  });

  test('an empty repository still gets a strategy, not a refusal', () => {
    const detection = detectFramework({ paths: [] });
    expect(detection.strategy).toBe('railpack');
    expect(detection.framework).toBe('unknown');
    expect(strategyLabel(detection)).toContain('Railpack');
  });

  test('a package.json we cannot parse does not throw', () => {
    const detection = detectFramework({ paths: ['package.json'], packageJson: '{ not json' });
    expect(detection.strategy).toBe('railpack');
  });
});

describe('build-time variables', () => {
  test('only name-matched variables pass', () => {
    const vars = buildTimeVariables({
      NEXT_PUBLIC_API_URL: 'https://api.example.com',
      VITE_FLAG: '1',
      DATABASE_URL: 'postgres://secret',
      PUBLIC_KEY: 'also baked in',
      PRIVATE_KEY: 'never',
    });

    expect(Object.keys(vars).toSorted()).toEqual([
      'NEXT_PUBLIC_API_URL',
      'PUBLIC_KEY',
      'VITE_FLAG',
    ]);
  });

  test('the prefix list is one list', () => {
    for (const prefix of BUILD_TIME_PREFIXES) {
      expect(isBuildTimeVariable(`${prefix}X`)).toBe(true);
    }
    expect(isBuildTimeVariable('NEXT_PUBLIC')).toBe(false);
  });

  test('output directories are framework defaults', () => {
    expect(defaultOutputDir('next')).toBe('out');
    expect(defaultOutputDir('cra')).toBe('build');
    expect(defaultOutputDir('vite')).toBe('dist');
    expect(defaultOutputDir('go')).toBe('dist');
  });
});
