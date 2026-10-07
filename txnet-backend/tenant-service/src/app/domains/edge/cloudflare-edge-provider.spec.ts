import { CloudflareEdgeProvider } from './cloudflare-edge-provider';
import { EdgeProviderError } from './edge-provider';
import { FakeEdgeProvider } from './fake-edge-provider';

/**
 * The invariants EDGE-1-c turns on (ADR-0129 (1, 3, 5), F-109):
 *
 * - A domain is registered as its own Custom Hostname, validated over HTTP —
 *   one hostname, one certificate, never a SAN shared with another reseller.
 * - Registering a host Cloudflare already holds answers that registration:
 *   our table is the list, and re-sending it never duplicates a hostname.
 * - Cloudflare's hostname and certificate states map onto `edgeStatus`, with
 *   the ownership TXT while Cloudflare still asks for it and its errors verbatim.
 * - A hostname already gone is `null` to `status` and no error to `remove`.
 * - A refusal is an `EdgeProviderError` naming what Cloudflare said.
 */
describe('CloudflareEdgeProvider', () => {
  const ZONE = 'zone-1';
  const BASE = `https://api.cloudflare.com/client/v4/zones/${ZONE}/custom_hostnames`;

  type Call = { url: string; method: string; body: unknown; auth: string | null };

  /** A scripted Cloudflare: each call takes the next answer. */
  const build = (...answers: Array<{ status?: number; body: unknown }>) => {
    const calls: Call[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url,
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : null,
        auth: headers.get('authorization'),
      });
      const answer = answers.shift();
      if (!answer) throw new Error(`unscripted call ${url}`);
      return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 });
    }) as typeof fetch;
    return { edge: new CloudflareEdgeProvider('tok-1', ZONE, fetchImpl), calls };
  };

  const ok = (result: unknown) => ({ body: { success: true, errors: [], result } });
  const refused = (status: number, code: number, message: string) => ({
    status,
    body: { success: false, errors: [{ code, message }], result: null },
  });

  /** Cloudflare's answer for a hostname behind a reseller's own CDN, before the TXT is set. */
  const pending = {
    id: 'ch-1',
    hostname: 'panel.shop.example',
    status: 'pending',
    verification_errors: ['custom hostname does not CNAME to this zone.'],
    ownership_verification: { type: 'txt', name: '_cf-custom-hostname.panel.shop.example', value: 'v-123' },
    ssl: { status: 'pending_validation', method: 'http', validation_errors: [{ message: 'caa_error: blocked' }] },
  };

  it('registers the host as its own hostname with an HTTP-validated DV certificate, with the zone token', async () => {
    const { edge, calls } = build(ok(pending));

    const got = await edge.register('panel.shop.example');

    expect(calls).toEqual([
      {
        url: BASE,
        method: 'POST',
        auth: 'Bearer tok-1',
        body: { hostname: 'panel.shop.example', ssl: { method: 'http', type: 'dv', settings: { min_tls_version: '1.2' } } },
      },
    ]);
    expect(got).toEqual({
      id: 'ch-1',
      host: 'panel.shop.example',
      status: 'issuing',
      ownership: { type: 'TXT', name: '_cf-custom-hostname.panel.shop.example', value: 'v-123' },
      errors: ['custom hostname does not CNAME to this zone.', 'caa_error: blocked'],
    });
  });

  it('answers a host Cloudflare already holds with that registration, never a second one', async () => {
    const { edge, calls } = build(refused(409, 1406, 'Duplicate custom hostname found.'), ok([pending]));

    const got = await edge.register('panel.shop.example');

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`POST ${BASE}`, `GET ${BASE}?hostname=panel.shop.example`]);
    expect(got.id).toBe('ch-1');
  });

  it.each([
    ['active', 'active', 'issued'],
    ['active', 'pending_deployment', 'issuing'],
    ['pending', 'initializing', 'issuing'],
    ['active', 'expired', 'renew_failed'],
    ['pending', 'validation_timed_out', 'failed'],
    ['pending', 'issuance_timed_out', 'failed'],
    ['blocked', 'pending_validation', 'failed'],
    ['moved', 'active', 'failed'],
  ])('maps hostname %s with certificate %s to %s', async (hostname, ssl, expected) => {
    const { edge } = build(ok({ id: 'ch-1', hostname: 'a.example', status: hostname, ssl: { status: ssl } }));
    expect((await edge.status('ch-1'))?.status).toBe(expected);
  });

  it('drops the ownership record once Cloudflare no longer asks for it', async () => {
    const { edge } = build(ok({ id: 'ch-1', hostname: 'a.example', status: 'active', ssl: { status: 'active' } }));
    expect(await edge.status('ch-1')).toEqual({ id: 'ch-1', host: 'a.example', status: 'issued', ownership: null, errors: [] });
  });

  it('reads a hostname gone from Cloudflare as null, and removing it again as done', async () => {
    const { edge, calls } = build(refused(404, 1436, 'Custom hostname not found.'), refused(404, 1436, 'Custom hostname not found.'));

    expect(await edge.status('ch-9')).toBeNull();
    await expect(edge.remove('ch-9')).resolves.toBeUndefined();
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`GET ${BASE}/ch-9`, `DELETE ${BASE}/ch-9`]);
  });

  it('refuses with what Cloudflare said', async () => {
    const { edge } = build(refused(403, 10000, 'Authentication error'));
    const err = await edge.register('a.example').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EdgeProviderError);
    expect((err as EdgeProviderError).detail).toBe('403 10000 Authentication error');
  });

  it('refuses when Cloudflare cannot be reached', async () => {
    const fetchImpl = (async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    }) as unknown as typeof fetch;
    const edge = new CloudflareEdgeProvider('tok-1', ZONE, fetchImpl);
    await expect(edge.status('ch-1')).rejects.toMatchObject({ operation: 'status', detail: 'ECONNRESET' });
  });
});

describe('FakeEdgeProvider', () => {
  it('holds one hostname per host, as the port promises', async () => {
    const edge = new FakeEdgeProvider();
    const first = await edge.register('a.example');
    expect(await edge.register('a.example')).toEqual(first);
    edge.set(first.id, { status: 'issued', ownership: null });
    expect((await edge.status(first.id))?.status).toBe('issued');
    await edge.remove(first.id);
    await edge.remove(first.id);
    expect(await edge.status(first.id)).toBeNull();
  });
});
