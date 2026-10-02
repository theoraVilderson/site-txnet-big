import type { Mock } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { CatalogSeasonWriteJob } from './catalog-season-write.job';

/**
 * F-505-b: the job that writes every tenant's coming season occurrences as
 * campaigns — billing-service's `POST /api/internal/catalog/seasons/write-upcoming`
 * (F-505-a). The failures worth a spec: the seam called on another service,
 * or without the token; an unset seam, a refusal or an answer without its
 * counts reported as "nothing was due" — Nowruz would come at full price and
 * nobody would know.
 */
describe('CatalogSeasonWriteJob', () => {
  const configWith = (values: Record<string, unknown>) =>
    ({ get: <T>(key: string, fallback?: T) => (values[key] as T) ?? (fallback as T) }) as unknown as ConfigService;
  const configured = { BILLING_API_BASE_URL: 'http://billing-service:3000/', SERVICE_AUTH_TOKEN: 'service-token' };
  const answer = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

  let fetchMock: Mock;
  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('asks billing-service, with the service token, and reports what it wrote and what it refused', async () => {
    fetchMock.mockResolvedValue(answer(200, { ok: true, msg: 'ok', data: { due: 3, written: 2, refused: 1 } }));
    const result = await new CatalogSeasonWriteJob(configWith(configured)).run();
    expect(fetchMock).toHaveBeenCalledWith('http://billing-service:3000/api/internal/catalog/seasons/write-upcoming', expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ 'x-service-token': 'service-token' }) }));
    expect(result).toEqual({ itemsProcessed: 2, errorsCount: 1, metrics: { due: 3, written: 2, refused: 1 } });
  });

  it('never succeeds quietly: an unset seam, a refusal, or an answer without its counts throws', async () => {
    await expect(new CatalogSeasonWriteJob(configWith({ SERVICE_AUTH_TOKEN: 't' })).run()).rejects.toThrow('BILLING_API_BASE_URL');
    fetchMock.mockResolvedValue(answer(404, {}));
    await expect(new CatalogSeasonWriteJob(configWith(configured)).run()).rejects.toThrow('404');
    fetchMock.mockResolvedValue(answer(200, { ok: true, msg: 'ok', data: { written: 1 } }));
    await expect(new CatalogSeasonWriteJob(configWith(configured)).run()).rejects.toThrow('counts');
  });
});
