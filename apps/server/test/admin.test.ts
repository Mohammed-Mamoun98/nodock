import { describe, expect, test } from 'bun:test';
import { createCaddyAdmin, createCaddyAdminFromConfig } from '../src/caddy/admin';

type Captured = { url: string; init: RequestInit & { unix?: string } };

function capturingFetch(status = 200, body = '') {
  const calls: Captured[] = [];
  const impl = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init: init as Captured['init'] });
    return new Response(body, { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('caddy admin client', () => {
  test('loads the Caddyfile over a unix socket, not TCP', async () => {
    const { impl, calls } = capturingFetch();
    const admin = createCaddyAdmin('http://localhost', impl, '/run/caddy/admin.sock');

    await admin.load(':80 {\n\trespond "ok"\n}\n');

    expect(calls[0]?.url).toBe('http://localhost/load');
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.unix).toBe('/run/caddy/admin.sock');
    expect(calls[0]?.init.body).toContain('respond "ok"');
  });

  test('never sets a socket when talking over TCP', async () => {
    const { impl, calls } = capturingFetch();
    const admin = createCaddyAdmin('http://caddy:2019/', impl);

    await admin.load(':80 {}');

    expect(calls[0]?.url).toBe('http://caddy:2019/load');
    expect(calls[0]?.init.unix).toBeUndefined();
  });

  test("a rejected config carries Caddy's own explanation", async () => {
    const { impl } = capturingFetch(400, 'adapting config: unrecognized directive: pwn');
    const admin = createCaddyAdmin('http://localhost', impl, '/run/caddy/admin.sock');

    await expect(admin.load(':80 {}')).rejects.toThrow(
      /Caddy rejected the config \(400\).*unrecognized directive/,
    );
  });

  test('the socket is preferred over a TCP url when both are configured', async () => {
    const { impl, calls } = capturingFetch();
    const original = globalThis.fetch;
    globalThis.fetch = impl;

    try {
      const admin = createCaddyAdminFromConfig({
        adminSocket: '/run/caddy/admin.sock',
        adminUrl: 'http://caddy:2019',
      });
      expect(admin).not.toBeNull();
      await admin?.load(':80 {}');
    } finally {
      globalThis.fetch = original;
    }

    expect(calls[0]?.init.unix).toBe('/run/caddy/admin.sock');
  });

  test('no admin endpoint at all means no client (a bare host without a proxy)', () => {
    expect(createCaddyAdminFromConfig({ adminSocket: null, adminUrl: null })).toBeNull();
  });
});
