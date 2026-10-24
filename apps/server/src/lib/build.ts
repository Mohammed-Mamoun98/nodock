import { z } from 'zod';

const trimSlashes = (value: string) => value.replace(/^\.\//, '').replace(/\/+$/, '').trim();

/**
 * Docker rejects a Dockerfile outside the build context, so nodock rejects it at
 * creation time instead of letting the CI build fail twenty minutes later.
 */
export function dockerfileOutsideContext(dockerfilePath: string, contextPath: string): boolean {
  const dockerfile = trimSlashes(dockerfilePath);
  const context = trimSlashes(contextPath);

  if (dockerfile.startsWith('../') || dockerfile.startsWith('/')) return true;
  if (context === '' || context === '.') return false;
  return !dockerfile.startsWith(`${context}/`);
}

export const repoFullName = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/, 'Expected owner/repo');

export const branch = z.string().trim().min(1).max(255);

export const dockerfilePath = z.string().trim().min(1).max(255).default('Dockerfile');
export const contextPath = z.string().trim().min(1).max(255).default('.');
export const containerPort = z.coerce.number().int().min(1).max(65535);
export const healthPath = z
  .string()
  .trim()
  .max(255)
  .regex(/^\/.*/, 'Health path must start with /');
export const memoryLimitMb = z.coerce.number().int().min(64).max(4096);
