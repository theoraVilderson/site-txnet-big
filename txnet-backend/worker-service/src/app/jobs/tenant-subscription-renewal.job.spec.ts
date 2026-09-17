import type { Mock } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { TenantSubscriptionRenewalJob } from './tenant-subscription-renewal.job';

/**
 * The invariant F-018-v turns on: **the sweep calls `tenant-service`**.
 *
 * Subscriptions and their renewal left `auth-service` (ADR-0058), and both
 * seams are reachable from this process with the same service token. So a job
 * left on `AUTH_API_BASE_URL` would not fail to connect — it would POST
 * `/api/internal/tenant-subscriptions/renew-due` at an app that no longer
 * serves it, get a 404 from `ServiceOnlyGuard`'s twin, and report a failed run
 * once a tick while every due reseller quietly went unrenewed and unsuspended.
 * Naming the variable in a test is what keeps the two seams apart.
 *
 * The rest of the job is `VaultRetentionJob`'s shape and its spec covers it:
 * an answer without the counts, or a refusal, throws rather than reporting an
 * empty success.
 */
describe('TenantSubscriptionRenewalJob', () => {
  const configWith = (values: Record<string, unknown>) =>
    ({ get: <T>(key: string, fallback?: T) => (values[key] as T) ?? (fallback as T) }) as unknown as ConfigService;

  const configured = {
    TENANT_API_BASE_URL: 'http://tenant-service:3000',
    AUTH_API_BASE_URL: 'http://auth-service:3001',
    SERVICE_AUTH_TOKEN: 'service-token',
    AUTH_API_TIMEOUT_MS: 30_000,
  };

  const sweep = { due: 2, failed: 0, renewed: 1, warned: 1, suspended: 0, waiting: 0, not_due: 0, skipped: 0 };
  const enveloped = (data: unknown) => ({ ok: true, msg: 'successful', data });
  const answer = (status: number, body: unknown) =>
    ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

  let fetchMock: Mock;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it("sweeps at tenant-service's internal route, not auth-service's", async () => {
    fetchMock.mockResolvedValue(answer(200, enveloped(sweep)));

    await new TenantSubscriptionRenewalJob(configWith(configured)).run();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://tenant-service:3000/api/internal/tenant-subscriptions/renew-due');
    expect(init.method).toBe('POST');
    expect(init.headers['x-service-token']).toBe('service-token');
  });

  it('refuses to run on an unset tenant seam, even with the auth seam configured', async () => {
    const { TENANT_API_BASE_URL: _unset, ...withoutTenant } = configured;

    await expect(new TenantSubscriptionRenewalJob(configWith(withoutTenant)).run()).rejects.toThrow('TENANT_API_BASE_URL is not set');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports the sweep counts as the run result', async () => {
    fetchMock.mockResolvedValue(answer(200, enveloped(sweep)));

    const result = await new TenantSubscriptionRenewalJob(configWith(configured)).run();

    expect(result).toEqual({ itemsProcessed: 2, errorsCount: 0, metrics: sweep });
  });
});
