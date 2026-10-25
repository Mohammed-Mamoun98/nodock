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
  /**
   * A slower cadence for data that is not *moving* but can still go wrong: a running
   * container can crash at any time, and the panel should say so without a reload.
   * Without this, a page would either poll fast forever or freeze on its first read.
   */
  recheckMs?: number;
  recheckWhen?: (data: T | null) => boolean;
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

  const { pollMs, shouldPoll, recheckMs, recheckWhen } = options;
  const shouldPollRef = useRef(shouldPoll);
  shouldPollRef.current = shouldPoll;
  const recheckRef = useRef(recheckWhen);
  recheckRef.current = recheckWhen;
  const tick = useRef(0);

  useEffect(() => {
    if (!pollMs) return;
    const every = recheckMs ? Math.max(1, Math.round(recheckMs / pollMs)) : 0;

    const timer = setInterval(() => {
      const stillChanging = shouldPollRef.current ? shouldPollRef.current(dataRef.current) : true;
      if (stillChanging) {
        tick.current = 0;
        reload();
        return;
      }
      tick.current += 1;
      const worthRechecking = every > 0 && (recheckRef.current?.(dataRef.current) ?? false);
      if (worthRechecking && tick.current >= every) {
        tick.current = 0;
        reload();
      }
    }, pollMs);

    return () => clearInterval(timer);
  }, [pollMs, recheckMs, reload]);

  return { data, error, loading, reload };
}
