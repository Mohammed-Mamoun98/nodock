export interface Me {
  login: string;
  avatarUrl: string | null;
  scopes: string[];
  missingScopes: string[];
  needsReconnect: boolean;
}

/** Returns null when the session is absent or expired (401), not an error. */
export async function fetchMe(): Promise<Me | null> {
  const response = await fetch('/api/me', { credentials: 'same-origin' });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error(`GET /api/me failed with ${response.status}`);
  return (await response.json()) as Me;
}

export async function signOut(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
}

export async function fetchControlPlaneRss(): Promise<number | null> {
  try {
    const response = await fetch('/metrics-lite');
    if (!response.ok) return null;
    const data = (await response.json()) as { rssMb: number };
    return data.rssMb;
  } catch {
    return null;
  }
}
