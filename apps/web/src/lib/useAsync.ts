import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './api';

export interface AsyncState<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  reload: () => void;
}

export interface AsyncOptions<T> {
  /**
   * Interval for background refreshes. The timer only *fires* when `shouldPoll`
   * says the data can still change, so an idle page makes no requests.
   */
  pollMs?: number;
  shouldPoll?: (data: T | null) => boolean;
}

/**
 * Deliberately small replacement for a query library: one request, a spinner, an
 * error, a retry, and optional condition-driven polling.
 */
export function useAsync<T>(
  loader: () => Promise<T>,
  deps: unknown[],
  options: AsyncOptions<T> = {},
): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  const dataRef = useRef<T | null>(null);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    loaderRef
      .current()
      .then((result) => {
        if (cancelled) return;
        dataRef.current = result;
        setData(result);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(
          cause instanceof ApiError ? cause : new ApiError(0, 'network_error', String(cause)),
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- callers pass their own deps
  }, [...deps, nonce]);

  const { pollMs, shouldPoll } = options;
  const shouldPollRef = useRef(shouldPoll);
  shouldPollRef.current = shouldPoll;

  useEffect(() => {
    if (!pollMs) return;

    const timer = setInterval(() => {
      const stillChanging = shouldPollRef.current ? shouldPollRef.current(dataRef.current) : true;
      if (stillChanging) reload();
    }, pollMs);

    return () => clearInterval(timer);
  }, [pollMs, reload]);

  return { data, error, loading, reload };
}
