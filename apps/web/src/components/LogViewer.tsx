import { useEffect, useRef, useState } from 'react';
import { useLogStream, type StreamState } from '../lib/logStream';

const stateLabel: Record<StreamState, string> = {
  connecting: 'connecting…',
  live: 'following',
  ended: 'ended',
  error: 'disconnected',
};

const stateTone: Record<StreamState, string> = {
  connecting: 'text-text-dim',
  live: 'text-lime',
  ended: 'text-text-dim',
  error: 'text-red',
};

/**
 * Monospace log pane that follows the tail unless the reader has scrolled up.
 * One component for both kinds of log: the deploy log (`chunk` frames) and the
 * container's own output (`line` frames) arrive through the same hook.
 */
export function LogViewer({
  url,
  empty,
  maxLines = 500,
  className = '',
}: {
  url: string | null;
  /** Shown before the first line arrives. */
  empty: string;
  maxLines?: number;
  className?: string;
}) {
  const { lines, state, restart } = useLogStream(url, maxLines);
  const scroller = useRef<HTMLDivElement | null>(null);
  const [follow, setFollow] = useState(true);

  useEffect(() => {
    const node = scroller.current;
    if (!node || !follow) return;
    node.scrollTop = node.scrollHeight;
    // `lines` is the trigger: scroll to the bottom once per new line, not once per
    // render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, follow]);

  return (
    <div
      className={`flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-line bg-canvas ${className}`}
    >
      <div
        ref={scroller}
        onScroll={(event) => {
          const node = event.currentTarget;
          setFollow(node.scrollHeight - node.scrollTop - node.clientHeight < 24);
        }}
        className="min-h-[80px] flex-1 overflow-y-auto p-3"
      >
        {lines.length === 0 ? (
          <p className="font-mono text-mono-xs text-text-dim">{empty}</p>
        ) : (
          <pre className="whitespace-pre-wrap break-all font-mono text-mono-xs leading-relaxed text-text">
            {lines.join('\n')}
          </pre>
        )}
      </div>

      <div className="flex shrink-0 items-center justify-between border-t border-line px-3 py-1.5">
        <span className={`font-mono text-[10px] ${stateTone[state]}`}>{stateLabel[state]}</span>
        <div className="flex items-center gap-3">
          {!follow ? (
            <button
              type="button"
              onClick={() => setFollow(true)}
              className="font-mono text-[10px] text-text-dim transition-colors hover:text-text"
            >
              jump to end
            </button>
          ) : null}
          <button
            type="button"
            onClick={restart}
            className="font-mono text-[10px] text-text-dim transition-colors hover:text-text"
          >
            reconnect
          </button>
        </div>
      </div>
    </div>
  );
}
