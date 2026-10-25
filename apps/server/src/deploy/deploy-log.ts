import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';

/**
 * One append-only file per deployment: the pull, the start, the health check and
 * the switch. Build output is *not* here — that is GitHub Actions, and the row
 * links to it.
 *
 * Files are plain text at `<data>/logs/<deploymentId>.log`, which means a log
 * survives a restart, a crash, and the deployment being read back later from the
 * history. Bytes, not lines, are the unit of reading: a follower keeps an offset.
 */
export interface DeployLogs {
  pathFor(deploymentId: string): string;
  append(deploymentId: string, line: string): void;
  /** Everything after `fromByte`, plus where to resume. */
  read(deploymentId: string, fromByte: number): { text: string; nextByte: number };
  /** Keeps the newest `keep` files, deletes the rest. Returns how many went. */
  prune(keep?: number): number;
}

/** A runaway pull can output a lot; 2 MB is plenty for one deployment. */
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_KEEP = 50;
/** Ids are uuids; anything else never becomes a path. */
const SAFE_ID = /^[A-Za-z0-9-]{1,64}$/;
const TRUNCATED = '\n[nodock] log truncated at 2 MB — the rest was dropped\n';

export function createDeployLogs(dir: string): DeployLogs {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const appended = new Map<string, number>();

  const pathFor = (deploymentId: string) => {
    if (!SAFE_ID.test(deploymentId)) {
      throw new Error(`Refusing to build a log path from ${JSON.stringify(deploymentId)}`);
    }
    return join(dir, `${deploymentId}.log`);
  };

  return {
    pathFor,

    append(deploymentId, line) {
      const path = pathFor(deploymentId);
      let size = appended.get(deploymentId);
      if (size === undefined) size = existsSync(path) ? statSync(path).size : 0;

      if (size >= MAX_BYTES) {
        if (size !== Number.MAX_SAFE_INTEGER) {
          appendFileSync(path, TRUNCATED, { mode: 0o600 });
          appended.set(deploymentId, Number.MAX_SAFE_INTEGER);
        }
        return;
      }

      // Terminal control codes and bare carriage returns only add noise to a
      // browser-rendered log. Stripping ESC sequences is the point of this regex.
      // eslint-disable-next-line no-control-regex
      const clean = line.replace(/\r/g, '').replace(/\u001b\[[0-9;]*m/g, '');
      const payload = Buffer.from(`${clean}\n`);
      const room = MAX_BYTES - size;

      // Cut mid-line rather than overshooting the cap: one 900 KB pull line must
      // not take the file past the budget it is supposed to respect.
      if (payload.length > room) {
        appendFileSync(path, payload.subarray(0, Math.max(0, room)), { mode: 0o600 });
        appendFileSync(path, TRUNCATED, { mode: 0o600 });
        appended.set(deploymentId, Number.MAX_SAFE_INTEGER);
        return;
      }

      appendFileSync(path, payload, { mode: 0o600 });
      appended.set(deploymentId, size + payload.length);
    },

    read(deploymentId, fromByte) {
      const path = pathFor(deploymentId);
      if (!existsSync(path)) return { text: '', nextByte: fromByte };

      const size = statSync(path).size;
      const start = Math.max(0, Math.min(fromByte, size));
      if (start >= size) return { text: '', nextByte: size };

      const length = size - start;
      const buffer = Buffer.alloc(length);
      const fd = openSync(path, 'r');
      try {
        readSync(fd, buffer, 0, length, start);
      } finally {
        closeSync(fd);
      }

      return { text: buffer.toString('utf8'), nextByte: size };
    },

    prune(keep = MAX_KEEP) {
      const files = readdirSync(dir)
        .filter((name) => name.endsWith('.log'))
        .map((name) => ({ name, mtime: statSync(join(dir, name)).mtimeMs }))
        .toSorted((a, b) => b.mtime - a.mtime);

      let removed = 0;
      for (const file of files.slice(keep)) {
        try {
          unlinkSync(join(dir, file.name));
          appended.delete(file.name.replace(/\.log$/, ''));
          removed += 1;
        } catch {
          // A file we cannot remove is not worth failing a deploy over.
        }
      }
      return removed;
    },
  };
}

/** Terminal states: nothing more will ever be written to that log. */
export function isTerminalStatus(status: string): boolean {
  return status === 'live' || status === 'failed' || status === 'cancelled';
}
