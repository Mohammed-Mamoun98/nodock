import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeployLogs, isTerminalStatus } from '../src/deploy/deploy-log';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'nodock-logs-'));
}

describe('deploy logs on disk', () => {
  test('appends lines and reads them back from an offset', () => {
    const dir = tempDir();
    const logs = createDeployLogs(dir);

    logs.append('dep-1', 'pulling ghcr.io/mo/app:abc');
    logs.append('dep-1', 'starting nodock-app-prod-1234');
    const first = logs.read('dep-1', 0);

    expect(first.text).toBe('pulling ghcr.io/mo/app:abc\nstarting nodock-app-prod-1234\n');
    expect(first.nextByte).toBe(Buffer.byteLength(first.text));

    logs.append('dep-1', 'live');
    const second = logs.read('dep-1', first.nextByte);

    expect(second.text).toBe('live\n');
    // Reading from the end yields nothing, and does not rewind.
    expect(logs.read('dep-1', second.nextByte)).toEqual({ text: '', nextByte: second.nextByte });
  });

  test('a log that was never written reads as empty instead of throwing', () => {
    const logs = createDeployLogs(tempDir());
    expect(logs.read('dep-missing', 0)).toEqual({ text: '', nextByte: 0 });
  });

  test('refuses ids that could escape the log directory', () => {
    const logs = createDeployLogs(tempDir());
    for (const id of ['../../etc/passwd', 'a/b', 'a b', '']) {
      expect(() => logs.pathFor(id)).toThrow(/Refusing/);
    }
  });

  test('strips carriage returns and colour codes so the browser shows text', () => {
    const logs = createDeployLogs(tempDir());
    logs.append('dep-1', '\u001b[32mStep 1/4\u001b[0m\r');

    expect(readFileSync(logs.pathFor('dep-1'), 'utf8')).toBe('Step 1/4\n');
  });

  test('caps a runaway log and says so once', () => {
    const logs = createDeployLogs(tempDir());
    const chunk = 'x'.repeat(900 * 1024);

    for (let index = 0; index < 4; index += 1) logs.append('dep-1', chunk);

    const text = readFileSync(logs.pathFor('dep-1'), 'utf8');
    expect(text.length).toBeLessThan(2.1 * 1024 * 1024);
    expect(text).toContain('log truncated at 2 MB');

    // Further appends are dropped, and the notice is not repeated forever.
    logs.append('dep-1', 'after the cap');
    const after = readFileSync(logs.pathFor('dep-1'), 'utf8');
    expect(after).not.toContain('after the cap');
    expect(after.match(/log truncated/g)).toHaveLength(1);
  });

  test('prunes the oldest files, keeping the newest', () => {
    const dir = tempDir();
    const logs = createDeployLogs(dir);

    for (const [index, id] of ['oldest', 'middle', 'newest'].entries()) {
      writeFileSync(join(dir, `${id}.log`), `${id}\n`);
      const stamp = new Date(Date.now() - (10 - index) * 1000);
      utimesSync(join(dir, `${id}.log`), stamp, stamp);
    }

    expect(logs.prune(2)).toBe(1);
    expect(readdirSync(dir).toSorted()).toEqual(['middle.log', 'newest.log']);
  });

  test('terminal statuses are the ones where nothing more will be written', () => {
    expect(isTerminalStatus('live')).toBe(true);
    expect(isTerminalStatus('failed')).toBe(true);
    expect(isTerminalStatus('cancelled')).toBe(true);
    expect(isTerminalStatus('pulling')).toBe(false);
    expect(isTerminalStatus('queued')).toBe(false);
  });
});
