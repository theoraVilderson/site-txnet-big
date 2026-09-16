/**
 * The billing side of the gateway-secret seam (F-102-c, D-31).
 *
 * `billing-service` holds a merchant id and secret key for exactly as long as
 * it takes to hand them to `auth-service`, the vault's only writer. What can go
 * wrong silently is all on the edges of that one call:
 *
 *  - the answer is **picked**, never passed through. If `auth-service` ever
 *    added a fingerprint or a value to its reply, a spread here would carry it
 *    to the panel;
 *  - a failure throws, and **its message carries no secret** — a failed call is
 *    exactly what gets logged, and the request body is the natural thing to put
 *    in the message;
 *  - an unset seam (`AUTH_API_BASE_URL` / `SERVICE_AUTH_TOKEN`) is a refusal,
 *    not a quiet "not configured" answer, which would read as a gateway with no
 *    secrets rather than a secret that was never stored;
 *  - an ownership refusal from the other side arrives as its reason, so the
 *    route answers it as the refusal it is and not as a 502.
 */
import { GatewaySecretsRefused, GatewaySecretsUnavailable, VaultSecretClient } from './vault-secret.client';

const TENANT = '11111111-1111-4111-8111-111111111111';
const GATEWAY = '22222222-2222-4222-8222-222222222222';
const ADMIN = '33333333-3333-4333-8333-333333333333';
const MERCHANT = 'zp-merchant-9f3c1e';
const SECRET = 'sk_live_very_secret_value';
const TOKEN = 'service-token-for-tests';

const target = { tenantId: TENANT, source: 'tenant' as const, gatewayId: GATEWAY };

const config = (values: Record<string, unknown>) => ({ get: (k: string, d?: unknown) => (k in values ? values[k] : d) });
const client = (values: Record<string, unknown> = { AUTH_API_BASE_URL: 'http://auth-service:3000/', SERVICE_AUTH_TOKEN: TOKEN }) =>
  new VaultSecretClient(config(values) as never);

const reply = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

describe('VaultSecretClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('posts the secrets to the internal seam with the service token, and nowhere else', async () => {
    fetchMock.mockResolvedValue(reply(200, { merchantId: { configured: true, version: 1, rotatedAt: null }, secretKey: { configured: true, version: 1, rotatedAt: null } }));

    await client().set(target, { merchantId: MERCHANT, secretKey: SECRET }, ADMIN);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://auth-service:3000/api/internal/vault/gateway-credential');
    expect(init.method).toBe('POST');
    expect(init.headers['x-service-token']).toBe(TOKEN);
    expect(JSON.parse(init.body)).toEqual({ ...target, merchantId: MERCHANT, secretKey: SECRET, actorId: ADMIN });
  });

  it('keeps only whether each secret is configured, whatever else the answer carries', async () => {
    fetchMock.mockResolvedValue(
      reply(200, {
        merchantId: { configured: true, version: 2, rotatedAt: '2026-09-13T10:00:00.000Z', fingerprint: 'fp-abc', value: MERCHANT },
        secretKey: { configured: false, version: null, rotatedAt: null },
        webhookSecret: { configured: true, version: 1, rotatedAt: null, value: 'whsec_x' },
        extra: SECRET,
      }),
    );

    const state = await client().state(target);

    expect(state).toEqual({
      merchantId: { configured: true, version: 2, rotatedAt: '2026-09-13T10:00:00.000Z' },
      secretKey: { configured: false, version: null, rotatedAt: null },
      webhookSecret: { configured: true, version: 1, rotatedAt: null },
    });
    expect(fetchMock.mock.calls[0][0]).toBe('http://auth-service:3000/api/internal/vault/gateway-credential/state');
  });

  it('throws on a failed call without the secret in the message', async () => {
    fetchMock.mockResolvedValue(reply(500, { message: 'boom' }));

    const error = await client().set(target, { merchantId: MERCHANT }, ADMIN).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GatewaySecretsUnavailable);
    expect(String((error as Error).message)).not.toContain(MERCHANT);
  });

  it("passes an ownership refusal on as its reason", async () => {
    fetchMock.mockResolvedValue(reply(403, { ok: false, error: { reason: 'not_owner' }, reason: 'not_owner' }));

    const error = await client().revoke(target).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GatewaySecretsRefused);
    expect((error as GatewaySecretsRefused).status).toBe(403);
  });

  it('refuses before calling anything when the seam is not configured', async () => {
    const error = await client({ AUTH_API_BASE_URL: 'http://auth-service:3000' }).state(target).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GatewaySecretsUnavailable);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
