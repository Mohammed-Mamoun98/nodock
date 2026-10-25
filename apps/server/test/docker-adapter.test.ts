import { describe, expect, test } from 'bun:test';
import { createDockerCli } from '../src/docker/adapter';

/**
 * `createDockerCli` takes its spawn function as an argument, so the parsing of real
 * `docker inspect` output is testable without a daemon. The strings below are copied
 * from a live Docker 28 host, including the error messages.
 */
function fakeSpawn(stdout: string, stderr = '', code = 0) {
  const calls: string[][] = [];
  const encoder = new TextEncoder();
  const stream = (text: string) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        if (text) controller.enqueue(encoder.encode(text));
        controller.close();
      },
    });

  const spawn = (args: string[]) => {
    calls.push(args);
    return { stdout: stream(stdout), stderr: stream(stderr), exited: Promise.resolve(code) };
  };

  return { spawn: spawn as unknown as typeof Bun.spawn, calls };
}

describe('docker inspect', () => {
  test('reads running, exit code, status, restarts and OOM as one line', async () => {
    const { spawn } = fakeSpawn('true 0 running 3 false\n');
    const state = await createDockerCli(spawn).inspect('nodock-api-prod-1');

    expect(state).toEqual({
      running: true,
      exitCode: 0,
      status: 'running',
      restartCount: 3,
      oomKilled: false,
    });
  });

  test('a crash loop and an OOM kill survive the round trip', async () => {
    const { spawn } = fakeSpawn('true 137 restarting 12 true\n');
    const state = await createDockerCli(spawn).inspect('nodock-api-prod-1');

    expect(state?.status).toBe('restarting');
    expect(state?.restartCount).toBe(12);
    expect(state?.oomKilled).toBe(true);
  });

  test('RestartCount is read off the container, not from .State', async () => {
    // Docker's own template error for `.State.RestartCount` is `map has no entry for
    // key "RestartCount"` — a failed inspect must never be mistaken for a missing
    // container, so the format string is pinned here.
    const { spawn, calls } = fakeSpawn('true 0 running 0 false\n');
    await createDockerCli(spawn).inspect('nodock-api-prod-1');

    const format = calls[0]?.join(' ') ?? '';
    expect(format).toContain('{{.RestartCount}}');
    expect(format).not.toContain('{{.State.RestartCount}}');
  });

  test('a container that is not there is null', async () => {
    const { spawn } = fakeSpawn('', 'error: no such object: nodock-api-prod-old\n', 1);
    expect(await createDockerCli(spawn).inspect('nodock-api-prod-old')).toBeNull();
  });

  test('an unreachable daemon throws, so callers cannot report a phantom outage', async () => {
    const { spawn } = fakeSpawn(
      '',
      'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n',
      1,
    );

    await expect(createDockerCli(spawn).inspect('x')).rejects.toThrow('Cannot connect');
  });
});
