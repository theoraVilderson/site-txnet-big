import { NotFoundException } from '@nestjs/common';
import { type ObjectDriver, guideFileRoles, guideMediaType, runWithTenant } from '@txnet-backend/shared-core';
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import {
  GUIDE_MEDIA_REDIRECT_MAX_AGE_SEC,
  GUIDE_MEDIA_URL_TTL_SEC,
  GuideMediaController,
  GuideMediaInternalController,
} from '../files/guide-media.controller';
import { GUIDE_VIDEO_POLICY, fileRoleRefusal } from './guide-admin';

/**
 * A guide's video (F-414-i, ADR-0116 point 3, ADR-0118). What breaks with
 * nothing red anywhere:
 *  - **the media route signing more than guide files** — it reads no row, so
 *    the key's shape (`guideMediaType`) is the only thing between a stranger
 *    and a branding draft, a support attachment, or a file half-written;
 *  - **a video block naming a picture, or a poster naming a video** — the
 *    `<video>` plays nothing, and the bot sends a broken file;
 *  - **a video policy that lets in what no player plays**.
 */
const T = '11111111-1111-4111-8111-111111111111';
const G = '22222222-2222-4222-8222-222222222222';
const F = '33333333-3333-4333-8333-333333333333';
const P = '44444444-4444-4444-8444-444444444444';
const VIDEO = `tenants/${T}/guides/${G}/${F}.mp4`;

describe('the media route hands out guide videos to a browser and nothing else', () => {
  it.each([[`tenants/${T}/guides/${G}/${F}.mp4`, 'video/mp4'], [`tenants/${T}/guides/${G}/${F}.webm`, 'video/webm']])('serves %s as %s', (key, type) => {
    expect(guideMediaType(key, 'browser')).toBe(type);
  });

  it.each([
    [`tenants/${T}/guides/${G}/${F}.png`, 'an image — the file route serves those, with its Host check'],
    [`tenants/${T}/branding/${F}.mp4`, 'another use of the store'],
    [`tenants/${T}/support/${G}/${F}.mp4`, 'a support attachment'],
    [`tenants/${T}/guides/${G}/${F}.mp4.${F}.tmp`, 'a file the driver is still writing'],
    [`tenants/${T}/guides/${G}/../../branding/${F}.mp4`, 'a climb out of guides/'],
    [`tenants/${T}/guides/${G}/${F}.MP4`, 'a key the port never mints'],
    [`tenants/x/guides/${G}/${F}.mp4`, 'a tenant that is not an id'],
  ])('refuses %s (%s)', (key) => {
    expect(guideMediaType(key, 'browser')).toBeNull();
  });
});

describe('the bot (F-414-f) gets guide pictures and videos and nothing else', () => {
  it('reads a guide image or video by key', () => {
    expect(guideMediaType(`tenants/${T}/guides/${G}/${F}.png`, 'bot')).toBe('image/png');
    expect(guideMediaType(`tenants/${T}/guides/${G}/${F}.jpg`, 'bot')).toBe('image/jpeg');
    expect(guideMediaType(VIDEO, 'bot')).toBe('video/mp4');
  });

  it.each([`tenants/${T}/branding/${F}.png`, `tenants/${T}/support/${G}/${F}.png`, `tenants/${T}/guides/${G}/${F}.png.${F}.tmp`])('refuses %s', (key) => {
    expect(guideMediaType(key, 'bot')).toBeNull();
  });
});

/** A driver that signs, and one that cannot (the volume). */
const volume: ObjectDriver = { write: vi.fn(), read: vi.fn(), remove: vi.fn() };
const signing = { ...volume, signedReadUrl: vi.fn(async (key: string) => `https://bucket.example/${key}?X-Amz-Signature=s`) };

function answer(): { status?: number; location?: string; headers: Record<string, string> } & Pick<Response, 'set' | 'redirect'> {
  const out: { status?: number; location?: string; headers: Record<string, string> } = { headers: {} };
  return Object.assign(out, {
    set: vi.fn((h: Record<string, string>) => Object.assign(out.headers, h)),
    redirect: vi.fn((status: number, url: string) => Object.assign(out, { status, location: url })),
  }) as never;
}
const request = (key: string): Request => ({ params: { key: key.split('/') } }) as never;
const platform = { id: async () => P };
const LOCAL_MEDIA = { get: () => 'http://guide-media:8081' } as never;

describe('the media route answers a short signed URL, never the bytes (ADR-0116 point 3)', () => {
  it("redirects a browser to the bucket, typed, for the Host's own video", async () => {
    const res = answer();
    await runWithTenant({ id: T }, () => new GuideMediaController(signing, platform as never).serve(request(VIDEO), res as never));
    expect(res.status).toBe(302);
    expect(res.location).toContain(VIDEO);
    expect(signing.signedReadUrl).toHaveBeenCalledWith(VIDEO, { expiresInSec: GUIDE_MEDIA_URL_TTL_SEC, contentType: 'video/mp4' });
    // The redirect itself is cached no longer than the URL it names lives.
    expect(res.headers['Cache-Control']).toBe(`private, max-age=${GUIDE_MEDIA_REDIRECT_MAX_AGE_SEC}`);
    expect(GUIDE_MEDIA_REDIRECT_MAX_AGE_SEC).toBeLessThan(GUIDE_MEDIA_URL_TTL_SEC);
  });

  it("serves the platform's video on a reseller's Host (rule 8), and no other tenant's", async () => {
    const platformVideo = VIDEO.replace(T, P);
    const other = VIDEO.replace(T, G);
    const controller = new GuideMediaController(signing, platform as never);
    const res = answer();
    await runWithTenant({ id: T }, () => controller.serve(request(platformVideo), res as never));
    expect(res.status).toBe(302);
    await expect(runWithTenant({ id: T }, () => controller.serve(request(other), answer() as never))).rejects.toThrow(NotFoundException);
  });

  it('is a 404 for a key the shape refuses', async () => {
    const controller = new GuideMediaController(signing, platform as never);
    await expect(runWithTenant({ id: T }, () => controller.serve(request(VIDEO.replace('.mp4', '.png')), answer() as never))).rejects.toThrow(NotFoundException);
  });

  it('on the volume, sends the browser to the media server and the bot to its in-network port (until F-018-m2-e)', async () => {
    const browser = answer();
    await runWithTenant({ id: T }, () => new GuideMediaController(volume, platform as never).serve(request(VIDEO), browser as never));
    expect([browser.status, browser.location]).toEqual([302, `/api/public/media/${VIDEO}`]);
    const bot = answer();
    await new GuideMediaInternalController(volume, LOCAL_MEDIA).serve(request(VIDEO), bot as never);
    expect([bot.status, bot.location]).toEqual([302, `http://guide-media:8081/${VIDEO}`]);
  });

  it('gives the bot pictures too, by tenant in the key, with no Host', async () => {
    const res = answer();
    const picture = VIDEO.replace('.mp4', '.png');
    await new GuideMediaInternalController(signing, LOCAL_MEDIA).serve(request(picture), res as never);
    expect(res.status).toBe(302);
    expect(signing.signedReadUrl).toHaveBeenCalledWith(picture, { expiresInSec: GUIDE_MEDIA_URL_TTL_SEC, contentType: 'image/png' });
  });
});

describe("a block's files are of the kind it plays", () => {
  const video = `tenants/${T}/guides/${G}/${F}.mp4`;
  const poster = `tenants/${T}/guides/${G}/${F}.jpg`;

  it('names a video block’s file a video and its poster an image; every other file an image', () => {
    const roles = guideFileRoles([
      { type: 'video', file: video, poster },
      { type: 'steps', items: [{ text: 'a', image: `tenants/${T}/guides/${G}/s.png` }] },
    ]);
    expect(Object.fromEntries(roles)).toEqual({ [video]: 'video', [poster]: 'image', [`tenants/${T}/guides/${G}/s.png`]: 'image' });
  });

  it('refuses a file of the other kind, and one used as both', () => {
    expect(fileRoleRefusal('video', 'video/mp4')).toBeNull();
    expect(fileRoleRefusal('video', 'video/webm')).toBeNull();
    expect(fileRoleRefusal('image', 'image/jpeg')).toBeNull();
    expect(fileRoleRefusal('video', 'image/png')).toBe('not a video');
    expect(fileRoleRefusal('image', 'video/mp4')).toBe('not an image');
    expect(() => guideFileRoles([{ type: 'video', file: video, poster: video }])).toThrow(/both/);
  });
});

describe('the video policy', () => {
  it('takes MP4 and WebM, public, up to 50 MiB', () => {
    expect([...GUIDE_VIDEO_POLICY.types].sort()).toEqual(['video/mp4', 'video/webm']);
    expect(GUIDE_VIDEO_POLICY.visibility).toBe('public');
    expect(GUIDE_VIDEO_POLICY.maxBytes).toBe(50 * 1024 * 1024);
  });
});
