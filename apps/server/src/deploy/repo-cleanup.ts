import { eq, inArray } from 'drizzle-orm';
import { decrypt, deriveKey } from '../auth/crypto';
import type { GitHubClient } from '../auth/github';
import { CI_SECRET_NAME } from '../ci/workflow';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { repoHooks, services, users } from '../db/schema';

export interface RepoCleanupDeps {
  config: Config;
  db: Db;
  github: GitHubClient;
}

export interface RepoCleanupResult {
  repo: string;
  removed: string[];
  errors: string[];
}

/**
 * Deregisters nodock's access to a repository once nobody deploys from it any more:
 * the push webhook (a credential), the CI token (a credential), and the repo_hooks row.
 *
 * It deliberately does **not** delete `.github/workflows/nodock.yml`. That file is the
 * user's code; removing it would mean committing a deletion to a repo nodock does not
 * own, and it may well be redeployed later.
 */
export async function cleanupReposIfUnused(
  deps: RepoCleanupDeps,
  repoFullNames: string[],
): Promise<RepoCleanupResult[]> {
  const { config, db, github } = deps;
  const results: RepoCleanupResult[] = [];
  const unique = [...new Set(repoFullNames.filter(Boolean))];
  if (unique.length === 0) return results;

  const adminRow = db
    .select({ tokenEnc: users.tokenEnc })
    .from(users)
    .all()
    .find((row) => row.tokenEnc);
  let adminToken: string | null = null;
  try {
    adminToken = adminRow?.tokenEnc ? decrypt(adminRow.tokenEnc, deriveKey(config.secret)) : null;
  } catch {
    adminToken = null;
  }

  for (const repo of unique) {
    const result: RepoCleanupResult = { repo, removed: [], errors: [] };
    results.push(result);

    const stillUsed = db
      .select({ id: services.id })
      .from(services)
      .where(eq(services.repoFullName, repo))
      .get();
    if (stillUsed) continue;

    const hook = db.select().from(repoHooks).where(eq(repoHooks.repoFullName, repo)).get();
    if (!hook) continue;

    if (adminToken && hook.hookId && github.deleteWebhook) {
      try {
        await github.deleteWebhook(adminToken, repo, hook.hookId);
        result.removed.push('webhook');
      } catch (error) {
        result.errors.push(`webhook: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (adminToken && github.deleteActionsSecret) {
      try {
        await github.deleteActionsSecret(adminToken, repo, CI_SECRET_NAME);
        result.removed.push(`secret ${CI_SECRET_NAME}`);
      } catch (error) {
        result.errors.push(`secret: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    db.delete(repoHooks).where(eq(repoHooks.repoFullName, repo)).run();
    result.removed.push('repo_hooks row');
  }

  return results;
}

/** Repositories owned by a set of services, captured before those rows are deleted. */
export function reposForServiceIds(db: Db, serviceIds: string[]): string[] {
  if (serviceIds.length === 0) return [];
  return db
    .select({ repoFullName: services.repoFullName })
    .from(services)
    .where(inArray(services.id, serviceIds))
    .all()
    .map((row) => row.repoFullName);
}
