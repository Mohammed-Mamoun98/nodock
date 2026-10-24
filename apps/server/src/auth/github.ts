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

export interface GitHubClient {
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
