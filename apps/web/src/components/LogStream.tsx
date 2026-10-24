import { useState } from 'react';
import type { LogLine } from '../lib/types';
import { Icon } from './Icon';

interface LogStreamProps {
  lines: LogLine[];
  height?: number;
}

export function LogStream({ lines, height = 140 }: LogStreamProps) {
  const [following, setFollowing] = useState(true);

  return (
    <div
      className="flex shrink-0 flex-col rounded-md border border-line bg-canvas p-3 font-mono text-mono-xs"
      style={{ height }}
    >
      <div className="flex-1 overflow-y-auto text-text-dim">
        {lines.map((line, index) => (
          <div key={`${line.time}-${index}`} className="grid grid-cols-[60px_1fr_12px] gap-2 py-0.5">
            <span className="tabular opacity-50">{line.time}</span>
            <span className="break-all">{line.text}</span>
            <span className="flex items-center">
              {following && index === lines.length - 1 ? (
                <span className="h-3 w-1.5 animate-blink bg-lime" aria-hidden />
              ) : null}
            </span>
          </div>
        ))}
      </div>

      <div className="mt-2 flex items-center justify-end border-t border-line pt-2">
        <button
          type="button"
          onClick={() => setFollowing((f) => !f)}
          className={`flex items-center gap-1.5 transition-opacity hover:opacity-80 ${
            following ? 'text-lime' : 'text-text-dim'
          }`}
        >
          {following ? (
            <span className="h-1.5 w-1.5 rounded-full bg-lime" aria-hidden />
          ) : (
            <Icon name="pause" className="h-3 w-3" />
          )}
          {following ? 'following' : 'paused'}
        </button>
      </div>
    </div>
  );
}
