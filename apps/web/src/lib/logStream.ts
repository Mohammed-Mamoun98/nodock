import { useCallback, useEffect, useState } from 'react';

export type StreamState = 'connecting' | 'live' | 'idle' | 'ended' | 'error';

/** A dropped socket is usually a sleep, a wifi switch or a proxy timeout — not a dead log. */
const MAX_ATTEMPTS = 3;
const RETRY_MS = 600;

interface Frame {
  event: string;
  data: string;
}

/**
 * Splits an SSE buffer into complete frames, keeping the trailing partial one.
 * The wire format here is ours (`chunk`, `line`, `end`), so this stays ~20 lines
 * instead of pulling in an EventSource polyfill. Comment frames (`: keepalive`) carry
 * no `data:` line, so they are dropped here by construction.
 */
function parseFrames(buffer: string): { frames: Frame[]; rest: string } {
  const parts = buffer.split('\n\n');
  const rest = parts.pop() ?? '';
  const frames: Frame[] = [];

  for (const part of parts) {
    let event = 'message';
    const data: string[] = [];
    for (const line of part.split('\n')) {
      if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
      else if (line.startsWith('data:')) data.push(line.slice('data:'.length).trimStart());
    }
    if (data.length > 0) frames.push({ event, data: data.join('\n') });
  }

  return { frames, rest };
}

/** The API answers with `{ error: { code, message } }`; show the sentence, not the JSON. */
async function failureText(response: Response): Promise<string> {
  const raw = await response.text().catch(() => '');
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string } };
    if (parsed.error?.message) return parsed.error.message;
  } catch {
    // Not our error envelope — a proxy's HTML page, for instance.
  }
  return raw || `stream failed (${response.status})`;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface LogStream {
  lines: string[];
  state: StreamState;
  restart: () => void;
}

/**
 * Follows a log endpoint. `fetch` + a reader rather than `EventSource`: the same
 * cookie/session path as the rest of the API, and a real abort on unmount, which
 * is what tells the server to stop following the container.
 */
export function useLogStream(url: string | null, maxLines = 500): LogStream {
  const [lines, setLines] = useState<string[]>([]);
  const [state, setState] = useState<StreamState>('connecting');
  const [nonce, setNonce] = useState(0);

  const restart = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    if (!url) return;

    const controller = new AbortController();
    let stopped = false;

    const append = (text: string) => {
      const incoming = text.split('\n').filter((line) => line.length > 0);
      if (incoming.length === 0) return;
      setLines((current) => {
        const next = [...current, ...incoming];
        // Bounded: a chatty app must not grow the tab's memory without limit.
        return next.length > maxLines ? next.slice(next.length - maxLines) : next;
      });
    };

    /** One attempt: either it finishes (ended, idle, failed) or it throws, and a throw
     * is the only thing the caller retries. */
    const connect = async (): Promise<void> => {
      const response = await fetch(url, {
        credentials: 'same-origin',
        signal: controller.signal,
        headers: { accept: 'text/event-stream' },
      });

      // 409 means there is nothing to follow yet (no live container). That is a
      // state, not a broken connection, and retrying would not change it.
      if (response.status === 409) {
        if (!stopped) setState('idle');
        return;
      }

      if (!response.ok || !response.body) {
        const detail = await failureText(response);
        // A rate-limit or an upstream blip is worth another try; a 404 is not.
        if (response.status === 429 || response.status >= 500) throw new Error(detail);
        if (!stopped) {
          append(detail);
          setState('error');
        }
        return;
      }
      if (stopped) return;
      setState('live');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        // Sequential by nature: the next chunk only exists after this one.
        // eslint-disable-next-line no-await-in-loop
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parsed = parseFrames(buffer);
        buffer = parsed.rest;

        for (const frame of parsed.frames) {
          if (frame.event === 'chunk') {
            append((JSON.parse(frame.data) as { text: string }).text);
          } else if (frame.event === 'line') {
            append((JSON.parse(frame.data) as { line: string }).line);
          } else if (frame.event === 'error') {
            // The server reports why it stopped following (no docker CLI, a
            // container that vanished) rather than dropping the connection.
            const detail =
              (JSON.parse(frame.data) as { error?: string }).error ?? 'log stream failed';
            append(detail);
            if (!stopped) setState('error');
            return;
          } else if (frame.event === 'end') {
            if (!stopped) setState('ended');
            return;
          }
        }
      }

      if (!stopped) setState('ended');
    };

    void (async () => {
      // Reset inside the async body, not synchronously in the effect: the effect
      // is here to own the connection, and a sync setState would cascade renders.
      setLines([]);
      setState('connecting');

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        try {
          // Sequential on purpose: attempt N+1 only exists once N failed.
          // eslint-disable-next-line no-await-in-loop
          await connect();
          return;
        } catch {
          if (stopped) return;
          if (attempt === MAX_ATTEMPTS) {
            setState('error');
            return;
          }
          setState('connecting');
          // eslint-disable-next-line no-await-in-loop
          await wait(RETRY_MS * attempt);
          if (stopped) return;
        }
      }
    })();

    return () => {
      stopped = true;
      controller.abort();
    };
    // maxLines is read inside the connection body; reconnecting for a new value
    // would drop the log the reader is looking at.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, nonce, maxLines]);

  return { lines, state, restart };
}
