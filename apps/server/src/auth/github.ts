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

export interface GitHubClient {
  authorizeUrl(input: { clientId: string; redirectUri: string; state: string }): string;
  exchangeCode(input: {
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
  }): Promise<GitHubToken>;
  getUser(accessToken: string): Promise<GitHubUser>;
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
  };
}
