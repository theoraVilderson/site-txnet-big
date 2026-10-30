import type { ConfigService } from '@nestjs/config';
import { RequestHeaders } from '@txnet-backend/shared-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { guideFileFetcher } from './guide-media.sender';

const KEY = 'tenants/11111111-1111-4111-8111-111111111111/guides/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333.png';
const SIGNED = 'https://hot.ir-central1.arvanstorage.ir/txnet-main-data/x.png?X-Amz-Signature=s';

const config = (values: Record<string, string>): ConfigService => ({ get: (name: string) => values[name] }) as never;
const bytes = (type: string) => new Response(Buffer.from([1, 2, 3]), { status: 200, headers: { 'content-type': type, 'content-length': '3' } });

afterEach(() => vi.unstubAllGlobals());

describe('the bot reads a guide file through tenant-service (F-018-m2-b)', () => {
  it('asks with the service token, then follows the redirect to the bucket without it', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: SIGNED } }))
      .mockResolvedValueOnce(bytes('image/png'));
    vi.stubGlobal('fetch', fetchMock);

    const fetched = await guideFileFetcher(config({ GUIDE_MEDIA_INTERNAL_URL: 'http://tenant-service:3000/api/internal/guide-media', SERVICE_AUTH_TOKEN: 't' }))(KEY);

    expect(fetched).toEqual({ bytes: Buffer.from([1, 2, 3]), contentType: 'image/png' });
    const [askUrl, ask] = fetchMock.mock.calls[0];
    expect(askUrl).toBe(`http://tenant-service:3000/api/internal/guide-media/${KEY}`);
    expect(ask.redirect).toBe('manual');
    expect(ask.headers[RequestHeaders.serviceToken]).toBe('t');
    // The token never leaves for the store: the second request carries no header of ours.
    const [storeUrl, store] = fetchMock.mock.calls[1];
    expect(storeUrl).toBe(SIGNED);
    expect(store.headers).toBeUndefined();
  });

  it('still takes the bytes when the answer is the file itself', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(bytes('video/mp4')));
    const fetched = await guideFileFetcher(config({ GUIDE_MEDIA_INTERNAL_URL: 'http://guide-media:8081' }))(KEY);
    expect(fetched?.contentType).toBe('video/mp4');
  });

  it('gives up on a redirect with nowhere to go', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(null, { status: 302 })));
    expect(await guideFileFetcher(config({ GUIDE_MEDIA_INTERNAL_URL: 'http://t' }))(KEY)).toBeNull();
  });
});
