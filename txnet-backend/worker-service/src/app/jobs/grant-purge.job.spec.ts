import { ConfigService } from '@nestjs/config';
import { GrantPurgeJob } from './grant-purge.job';

/**
 * The purge tick also runs the close stage (F-118-x), and a close moves money.
 * What this holds: the run log (`bot_execution_log`) carries the close counts,
 * and a close that rolled back is an **error** of the run — `TickConsumer`
 * records `partial`/`failed` rather than a quiet `success` — while an answer
 * missing its counts still fails the run whole (automation invariant #3).
 */
describe('GrantPurgeJob', () => {
  const config = {
    get: <T>(key: string, fallback: T): T =>
      ({ BILLING_API_BASE_URL: 'http://billing', SERVICE_AUTH_TOKEN: 't' } as Record<string, unknown>)[key] as T ?? fallback,
  } as unknown as ConfigService;

  const answer = (data: Record<string, unknown>) =>
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true, msg: 'ok', data }), { status: 200 }));

  const counts = { scanned: 2, grantsPurged: 2, configsPurged: 3, told: 1, closed: 4, closeFailed: 0 };

  afterEach(() => vi.restoreAllMocks());

  it('records the closes beside the purge, as items of the run', async () => {
    answer(counts);
    const result = await new GrantPurgeJob(config).run();
    expect(result).toEqual({ itemsProcessed: 7, errorsCount: 0, metrics: counts });
  });

  it('counts a close that rolled back as an error of the run', async () => {
    answer({ ...counts, closed: 1, closeFailed: 2 });
    const result = await new GrantPurgeJob(config).run();
    expect(result.errorsCount).toBe(2);
    expect(result.metrics).toMatchObject({ closed: 1, closeFailed: 2 });
  });

  it('fails the run when billing answers without the close counts', async () => {
    const { closed: _c, closeFailed: _f, ...old } = counts;
    answer(old);
    await expect(new GrantPurgeJob(config).run()).rejects.toThrow(/without its counts/);
  });
});
