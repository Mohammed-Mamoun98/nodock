import { sealSecret } from '../ci/sealed-box';

export interface GitHubUser {
  id: number;
  login: string;
  avatarUrl: string | null;
}

export interface GitHubToken {
  accessToken: string;
  /** Scopes GitHub actually granted — users can accept less than requested. */
  scopes: string[];
}

export interface GitHubRepo {
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
  archived: boolean;
  defaultBranch: string;
  pushedAt: string | null;
}

/** A GitHub failure we can turn into a precise API error instead of a 500. */
export class GitHubHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'GitHubHttpError';
    this.status = status;
  }
}

export interface GitHubRepoInfo {
  fullName: string;
  defaultBranch: string;
  private: boolean;
}

export interface GitHubFile {
  sha: string;
  content: string;
}

/**
 * Operations the CI integration needs. Optional so existing fakes stay valid;
 * the CI routes answer 501 when a client does not implement them.
 */
export interface GitHubOps {
  listTree?(
    accessToken: string,
    repoFullName: string,
    ref: string,
  ): Promise<{ paths: string[]; truncated: boolean }>;
  getRepo?(accessToken: string, repoFullName: string): Promise<GitHubRepoInfo>;
  getBranchHead?(accessToken: string, repoFullName: string, branch: string): Promise<string>;
  getFile?(
    accessToken: string,
    repoFullName: string,
    path: string,
    ref: string,
  ): Promise<GitHubFile | null>;
  putFile?(
    accessToken: string,
    repoFullName: string,
    input: { path: string; content: string; message: string; branch: string; sha?: string },
  ): Promise<{ commitSha: string; contentSha: string }>;
  putActionsSecret?(
    accessToken: string,
    repoFullName: string,
    name: string,
    value: string,
  ): Promise<void>;
  createWebhook?(
    accessToken: string,
    repoFullName: string,
    input: { url: string; secret: string },
  ): Promise<{ id: number }>;
  dispatchBuild?(
    accessToken: string,
    repoFullName: string,
    eventType: string,
    payload: Record<string, string>,
  ): Promise<void>;
}

export interface GitHubClient extends GitHubOps {
  authorizeUrl(input: { clientId: string; redirectUri: string; state: string }): string;
  exchangeCode(input: {
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
  }): Promise<GitHubToken>;
  getUser(accessToken: string): Promise<GitHubUser>;
  listRepos(
    accessToken: string,
    page?: { page: number; perPage: number },
  ): Promise<{ repos: GitHubRepo[]; hasMore: boolean }>;
  listBranches(accessToken: string, repoFullName: string): Promise<string[]>;
}

/** Scopes nodock needs: `repo` for hooks/dispatch/contents, `workflow` to commit the CI file. */
export const REQUIRED_SCOPES = ['repo', 'workflow'] as const;

export function missingScopes(granted: string[]): string[] {
  return REQUIRED_SCOPES.filter((scope) => !granted.includes(scope));
}

export function createGitHubClient(fetchImpl: typeof fetch = fetch): GitHubClient {
  return {
    authorizeUrl({ clientId, redirectUri, state }) {
      const url = new URL('https://github.com/login/oauth/authorize');
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('scope', REQUIRED_SCOPES.join(' '));
      url.searchParams.set('state', state);
      url.searchParams.set('allow_signup', 'false');
      return url.toString();
    },

    async exchangeCode({ clientId, clientSecret, code, redirectUri }) {
      const response = await fetchImpl('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: redirectUri,
        }),
      });

      if (!response.ok) {
        throw new Error(`GitHub token exchange failed with ${response.status}`);
      }

      const body = (await response.json()) as {
        access_token?: string;
        scope?: string;
        error?: string;
        error_description?: string;
      };

      if (body.error || !body.access_token) {
        throw new Error(body.error_description ?? body.error ?? 'GitHub returned no access token');
      }

      return {
        accessToken: body.access_token,
        scopes: (body.scope ?? '').split(/[ ,]+/).filter(Boolean),
      };
    },

    async getUser(accessToken) {
      const response = await fetchImpl('https://api.github.com/user', {
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: 'application/vnd.github+json',
          'user-agent': 'nodock',
        },
      });

      if (response.status === 401) throw new Error('GitHub rejected the token (401)');
      if (!response.ok) throw new Error(`GitHub /user failed with ${response.status}`);

      const body = (await response.json()) as { id: number; login: string; avatar_url?: string };
      return { id: body.id, login: body.login, avatarUrl: body.avatar_url ?? null };
    },

    async listRepos(accessToken, page = { page: 1, perPage: 100 }) {
      const url = new URL('https://api.github.com/user/repos');
      url.searchParams.set('per_page', String(page.perPage));
      url.searchParams.set('page', String(page.page));
      url.searchParams.set('sort', 'pushed');
      url.searchParams.set('affiliation', 'owner,collaborator,organization_member');

      const response = await githubFetch(fetchImpl, url.toString(), accessToken);
      const body = (await response.json()) as GitHubRepoRaw[];

      return {
        repos: body.map((repo) => ({
          fullName: repo.full_name,
          name: repo.name,
          owner: repo.owner?.login ?? repo.full_name.split('/')[0] ?? '',
          private: repo.private,
          archived: repo.archived ?? false,
          defaultBranch: repo.default_branch ?? 'main',
          pushedAt: repo.pushed_at ?? null,
        })),
        hasMore: body.length === page.perPage,
      };
    },

    async listTree(accessToken, repoFullName, ref) {
      const response = await githubFetch(
        fetchImpl,
        `https://api.github.com/repos/${repoPath(repoFullName)}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
        accessToken,
      );
      const body = (await response.json()) as {
        tree?: { path: string; type: string }[];
        truncated?: boolean;
      };

      return {
        paths: (body.tree ?? [])
          .filter((entry) => entry.type === 'blob')
          .map((entry) => entry.path),
        truncated: body.truncated ?? false,
      };
    },

    async getRepo(accessToken, repoFullName) {
      const response = await githubFetch(
        fetchImpl,
        `https://api.github.com/repos/${repoPath(repoFullName)}`,
        accessToken,
      );
      const body = (await response.json()) as {
        full_name: string;
        default_branch?: string;
        private?: boolean;
      };
      return {
        fullName: body.full_name,
        defaultBranch: body.default_branch ?? 'main',
        private: body.private ?? false,
      };
    },

    async getBranchHead(accessToken, repoFullName, branch) {
      const response = await githubFetch(
        fetchImpl,
        `https://api.github.com/repos/${repoPath(repoFullName)}/commits/${encodeURIComponent(branch)}`,
        accessToken,
      );
      const body = (await response.json()) as { sha?: string };
      if (!body.sha) throw new GitHubHttpError(502, 'GitHub returned no commit for that branch');
      return body.sha;
    },

    async getFile(accessToken, repoFullName, path, ref) {
      const response = await fetchImpl(
        `https://api.github.com/repos/${repoPath(repoFullName)}/contents/${path
          .split('/')
          .map(encodeURIComponent)
          .join('/')}?ref=${encodeURIComponent(ref)}`,
        {
          headers: {
            authorization: `Bearer ${accessToken}`,
            accept: 'application/vnd.github+json',
            'user-agent': 'nodock',
          },
        },
      );

      if (response.status === 404) return null;
      if (!response.ok) throw new GitHubHttpError(response.status, 'Could not read that file');

      const body = (await response.json()) as { sha: string; content?: string };
      return {
        sha: body.sha,
        content: Buffer.from(body.content ?? '', 'base64').toString('utf8'),
      };
    },

    async putFile(accessToken, repoFullName, input) {
      const response = await fetchImpl(
        `https://api.github.com/repos/${repoPath(repoFullName)}/contents/${input.path
          .split('/')
          .map(encodeURIComponent)
          .join('/')}`,
        {
          method: 'PUT',
          headers: {
            authorization: `Bearer ${accessToken}`,
            accept: 'application/vnd.github+json',
            'content-type': 'application/json',
            'user-agent': 'nodock',
          },
          body: JSON.stringify({
            message: input.message,
            content: Buffer.from(input.content, 'utf8').toString('base64'),
            branch: input.branch,
            ...(input.sha ? { sha: input.sha } : {}),
          }),
        },
      );

      if (response.status === 403 || response.status === 404) {
        throw new GitHubHttpError(
          403,
          'GitHub refused the workflow commit — the token needs the `workflow` scope, and branch protection may block it',
        );
      }
      if (!response.ok) {
        throw new GitHubHttpError(
          response.status,
          `Could not commit the workflow (${response.status})`,
        );
      }

      const body = (await response.json()) as { commit: { sha: string }; content: { sha: string } };
      return { commitSha: body.commit.sha, contentSha: body.content.sha };
    },

    async putActionsSecret(accessToken, repoFullName, name, value) {
      const keyResponse = await githubFetch(
        fetchImpl,
        `https://api.github.com/repos/${repoPath(repoFullName)}/actions/secrets/public-key`,
        accessToken,
      );
      const keyBody = (await keyResponse.json()) as { key: string; key_id: string };

      const response = await fetchImpl(
        `https://api.github.com/repos/${repoPath(repoFullName)}/actions/secrets/${encodeURIComponent(name)}`,
        {
          method: 'PUT',
          headers: {
            authorization: `Bearer ${accessToken}`,
            accept: 'application/vnd.github+json',
            'content-type': 'application/json',
            'user-agent': 'nodock',
          },
          body: JSON.stringify({
            encrypted_value: sealSecret(value, keyBody.key),
            key_id: keyBody.key_id,
          }),
        },
      );

      if (!response.ok) {
        throw new GitHubHttpError(
          response.status,
          `Could not store the Actions secret (${response.status}); Actions may be disabled for this repo`,
        );
      }
    },

    async createWebhook(accessToken, repoFullName, input) {
      const response = await fetchImpl(
        `https://api.github.com/repos/${repoPath(repoFullName)}/hooks`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${accessToken}`,
            accept: 'application/vnd.github+json',
            'content-type': 'application/json',
            'user-agent': 'nodock',
          },
          body: JSON.stringify({
            name: 'web',
            active: true,
            events: ['push'],
            config: {
              url: input.url,
              content_type: 'json',
              secret: input.secret,
              insecure_ssl: '0',
            },
          }),
        },
      );

      if (!response.ok) {
        throw new GitHubHttpError(
          response.status,
          `Could not create the webhook (${response.status})`,
        );
      }

      const body = (await response.json()) as { id: number };
      return { id: body.id };
    },

    async dispatchBuild(accessToken, repoFullName, eventType, payload) {
      const response = await fetchImpl(
        `https://api.github.com/repos/${repoPath(repoFullName)}/dispatches`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${accessToken}`,
            accept: 'application/vnd.github+json',
            'content-type': 'application/json',
            'user-agent': 'nodock',
          },
          body: JSON.stringify({ event_type: eventType, client_payload: payload }),
        },
      );

      if (!response.ok) {
        throw new GitHubHttpError(
          response.status,
          `repository_dispatch failed (${response.status}) — is the nodock workflow on the default branch?`,
        );
      }
    },

    async listBranches(accessToken, repoFullName) {
      const url =
        'https://api.github.com/repos/' +
        repoFullName.split('/').map(encodeURIComponent).join('/') +
        '/branches?per_page=100';

      const response = await githubFetch(fetchImpl, url, accessToken);
      const body = (await response.json()) as { name: string }[];
      return body.map((branch) => branch.name);
    },
  };
}

function repoPath(repoFullName: string): string {
  return repoFullName.split('/').map(encodeURIComponent).join('/');
}

interface GitHubRepoRaw {
  full_name: string;
  name: string;
  private: boolean;
  archived?: boolean;
  default_branch?: string;
  pushed_at?: string | null;
  owner?: { login?: string };
}

async function githubFetch(fetchImpl: typeof fetch, url: string, accessToken: string) {
  const response = await fetchImpl(url, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'nodock',
      'x-github-api-version': '2022-11-28',
    },
  });

  if (response.status === 401) {
    throw new GitHubHttpError(401, 'GitHub rejected the token — reconnect GitHub in settings');
  }
  if (response.status === 404) {
    throw new GitHubHttpError(404, 'Repository not found, or the token lacks access to it');
  }
  if (response.status === 403 || response.status === 429) {
    const reset = response.headers.get('x-ratelimit-reset');
    throw new GitHubHttpError(
      429,
      `GitHub rate limit reached${reset ? ` (resets at ${new Date(Number(reset) * 1000).toISOString()})` : ''}`,
    );
  }
  if (!response.ok) {
    throw new GitHubHttpError(response.status, `GitHub request failed with ${response.status}`);
  }

  return response;
}
