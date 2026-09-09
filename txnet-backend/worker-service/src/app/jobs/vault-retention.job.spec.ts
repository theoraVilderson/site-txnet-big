import { ConfigService } from '@nestjs/config';
import { VaultRetentionJob } from './vault-retention.job';

/**
 * What this job must never do is **succeed quietly**.
 *
 * It is a retention sweep, so its failure mode is silence: an unset token, a
 * 404 from a guard, an answer in a shape it does not understand. Every one of
 * those looks exactly like "nothing was due" from the outside — a `success`
 * row with `itemsProcessed: 0`, appended once an hour, for ever. A superseded
 * DEK version would then outlive its grace window indefinitely and the run log
 * would say the sweep was healthy the whole time (ADR-0026 rule 4).
 *
 * So the invariant stated here is: **the only run this job reports as a
 * success is one where auth-api answered with a count.** Everything else
 * throws, which `TickConsumer` records as `failed` (automation invariant #3).
 */
describe('VaultRetentionJob', () => {
  const configWith = (values: Record<string, unknown>) =>
    ({
      get: <T>(key: string, fallback?: T) =>
        (values[key] as T) ?? (fallback as T),
    }) as unknown as ConfigService;

  const configured = {
    AUTH_API_BASE_URL: 'http://auth-service:3001',
    SERVICE_AUTH_TOKEN: 'service-token',
    AUTH_API_TIMEOUT_MS: 30_000,
  };

  const answer = (status: number, body: unknown) =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as Response;

  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('reports the count auth-api destroyed', async () => {
    fetchMock.mockResolvedValue(answer(200, { destroyed: 3 }));

    const result = await new VaultRetentionJob(configWith(configured)).run();

    expect(result).toEqual({
      itemsProcessed: 3,
      errorsCount: 0,
      metrics: { destroyed: 3 },
    });
  });

  it('calls the internal route with the service token, and nothing else', async () => {
    fetchMock.mockResolvedValue(answer(200, { destroyed: 0 }));

    await new VaultRetentionJob(configWith(configured)).run();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://auth-service:3001/api/internal/vault/destroy-expired');
    expect(init.method).toBe('POST');
    expect(init.headers['x-service-token']).toBe('service-token');
    // No tenant header: the sweep is platform-wide and the route is
    // `@TenantAgnostic`. Naming a tenant here would be a scope it does not have.
    expect(init.headers['x-tenant-id']).toBeUndefined();
  });

  it('a run that destroyed nothing is still a success', async () => {
    fetchMock.mockResolvedValue(answer(200, { destroyed: 0 }));

    const result = await new VaultRetentionJob(configWith(configured)).run();

    expect(result.itemsProcessed).toBe(0);
    expect(result.errorsCount).toBe(0);
  });

  it('fails the run when the seam is not configured, rather than reporting zero', async () => {
    const job = new VaultRetentionJob(
      configWith({ ...configured, SERVICE_AUTH_TOKEN: '' }),
    );

    await expect(job.run()).rejects.toThrow(/SERVICE_AUTH_TOKEN/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails the run when auth-api refuses the call', async () => {
    // 404 is what `ServiceOnlyGuard` answers a caller without the token, so
    // this is the shape a rotated-away service token actually takes.
    fetchMock.mockResolvedValue(answer(404, {}));

    await expect(
      new VaultRetentionJob(configWith(configured)).run(),
    ).rejects.toThrow(/404/);
  });

  it('fails the run when the answer carries no count', async () => {
    fetchMock.mockResolvedValue(answer(200, { ok: true, data: { destroyed: 2 } }));

    await expect(
      new VaultRetentionJob(configWith(configured)).run(),
    ).rejects.toThrow(/destroyed/);
  });

  it('fails the run when auth-api cannot be reached', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(
      new VaultRetentionJob(configWith(configured)).run(),
    ).rejects.toThrow(/ECONNREFUSED/);
  });
});
