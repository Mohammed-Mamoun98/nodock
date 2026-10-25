import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `scripts/self-update.sh` is what upgrades the panel on the box, and its rollback
 * path is the one thing that must never be wrong. Tested against a fake `docker`
 * on PATH, so this stays offline and needs no daemon.
 */
const script = join(import.meta.dir, '../../../scripts/self-update.sh');

/** Records calls; `up -d` "runs" whatever image NODOCK_IMAGE points at. */
const FAKE_DOCKER = `#!/bin/sh
echo "docker $*" >> "$STUB_LOG"
case "$1" in
  inspect) cat "$STUB_STATE"; exit 0 ;;
  login) cat >/dev/null; exit 0 ;;
esac
if [ "$1" = "compose" ]; then
  shift
  while [ "$1" = "-f" ]; do shift 2; done
  cmd="$1"
  shift
  case "$cmd" in
    ps) echo cid1 ;;
    exec) [ "$(cat "$STUB_STATE")" = "\${STUB_BROKEN:-none}" ] && exit 1 || exit 0 ;;
    pull) exit 0 ;;
    up) echo "\${NODOCK_IMAGE:-<default>}" > "$STUB_STATE"; exit 0 ;;
  esac
fi
exit 0
`;

const TAG_PREFIX = 'ghcr.io/mohammed-mamoun98/nodock:';

function harness(running: string) {
  const dir = mkdtempSync(join(tmpdir(), 'nodock-selfupdate-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'docker'), FAKE_DOCKER);
  chmodSync(join(bin, 'docker'), 0o755);

  const state = join(dir, 'running');
  const log = join(dir, 'calls.log');
  writeFileSync(state, running);
  writeFileSync(log, '');

  const run = (args: string[], extraEnv: Record<string, string> = {}) =>
    Bun.spawnSync([script, ...args], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        STUB_LOG: log,
        STUB_STATE: state,
        STATE_DIR: join(dir, 'state'),
        HEALTH_ATTEMPTS: '1',
        ...extraEnv,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

  return {
    dir,
    state,
    log,
    run,
    running: () => readFileSync(state, 'utf8').trim(),
    recorded: (file: 'current-image' | 'previous-image') => {
      try {
        return readFileSync(join(dir, 'state', file), 'utf8').trim();
      } catch {
        return null;
      }
    },
    calls: () => readFileSync(log, 'utf8'),
  };
}

describe('self-update', () => {
  test('deploys the tag, remembers what ran before, and checks health', () => {
    const h = harness('nodock:dev');

    const result = h.run(['sha-1a2b3c4']);

    expect(result.exitCode).toBe(0);
    expect(h.running()).toBe(`${TAG_PREFIX}sha-1a2b3c4`);
    expect(h.recorded('current-image')).toBe(`${TAG_PREFIX}sha-1a2b3c4`);
    expect(h.recorded('previous-image')).toBe('nodock:dev');
    expect(h.calls()).toContain('pull nodock');
    expect(h.calls()).toContain('127.0.0.1:3000/healthz');
  });

  test('a build that never answers is rolled back and reported as a failure', () => {
    const h = harness(`${TAG_PREFIX}sha-good000`);

    const result = h.run(['sha-bad0000'], { STUB_BROKEN: `${TAG_PREFIX}sha-bad0000` });

    expect(result.exitCode).toBe(1);
    // The box is back on the image that was serving, not on the broken one.
    expect(h.running()).toBe(`${TAG_PREFIX}sha-good000`);
    // State is only written after a healthy deploy, so a failed one cannot poison
    // the record of what `--rollback` should return to.
    expect(h.recorded('current-image')).toBeNull();
    expect(result.stderr.toString()).toContain('health check failed');
    expect(result.stderr.toString()).toContain('rolled back');
  });

  test('--rollback switches back to the recorded previous image', () => {
    const h = harness(`${TAG_PREFIX}sha-good000`);
    h.run(['sha-next00']);

    const result = h.run(['--rollback']);

    expect(result.exitCode).toBe(0);
    expect(h.running()).toBe(`${TAG_PREFIX}sha-good000`);
  });

  test('accepts a full image ref, so a locally built tag can be restored', () => {
    const h = harness(`${TAG_PREFIX}sha-good000`);

    const result = h.run(['nodock:dev']);

    expect(result.exitCode).toBe(0);
    expect(h.running()).toBe('nodock:dev');
    // A local image has nothing to pull.
    expect(h.calls()).not.toContain('pull nodock');
  });

  test('refuses to roll back when it has no record of a previous image', () => {
    const h = harness(`${TAG_PREFIX}sha-good000`);

    const result = h.run(['--rollback']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('nothing to roll back to');
    expect(h.running()).toBe(`${TAG_PREFIX}sha-good000`);
  });

  test('prints usage instead of guessing when called with no argument', () => {
    const h = harness(`${TAG_PREFIX}sha-good000`);

    const result = h.run([]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('usage:');
  });
});
