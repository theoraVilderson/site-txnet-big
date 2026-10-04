import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { guideFileRoles } from '@txnet-backend/shared-core';
import { describe, expect, it } from 'vitest';

import { GUIDE_VIDEO_POLICY, fileRoleRefusal } from './guide-admin';

/**
 * A guide's video (F-414-i, ADR-0116 point 3, ADR-0118). What breaks with
 * nothing red anywhere:
 *  - **the media server serving more than guide videos** — it reads the whole
 *    object volume with no Host or tenant check, so its one `location` is the
 *    only thing between a stranger and a branding draft, a support
 *    attachment, or a file half-written;
 *  - **a video block naming a picture, or a poster naming a video** — the
 *    `<video>` plays nothing, and the bot sends a broken file;
 *  - **a video policy that lets in what no player plays**.
 */
const REPO = join(__dirname, '../../../../..');
const CONF = readFileSync(join(REPO, 'dev-docker/media/guide-media.conf'), 'utf8');
const [publicLocation, internalLocation] = [...CONF.matchAll(/location ~ "([^"]+)"/g)].map((m) => new RegExp(m[1]));
const served = publicLocation ?? /^$/;

const T = '11111111-1111-4111-8111-111111111111';
const G = '22222222-2222-4222-8222-222222222222';
const F = '33333333-3333-4333-8333-333333333333';

describe('the media server serves guide videos and nothing else', () => {
  it.each([`/tenants/${T}/guides/${G}/${F}.mp4`, `/tenants/${T}/guides/${G}/${F}.webm`])('serves %s', (path) => {
    expect(served.test(path)).toBe(true);
  });

  it.each([
    [`/tenants/${T}/guides/${G}/${F}.png`, 'an image — the file route serves those, with its Host check'],
    [`/tenants/${T}/branding/${F}.mp4`, 'another use of the volume'],
    [`/tenants/${T}/support/${G}/${F}.mp4`, 'a support attachment'],
    [`/tenants/${T}/guides/${G}/${F}.mp4.${F}.tmp`, 'a file the driver is still writing'],
    [`/tenants/${T}/guides/${G}/../../branding/${F}.mp4`, 'a climb out of guides/'],
    [`/tenants/${T}/guides/${G}/${F}.MP4`, 'a key the port never mints'],
    [`/tenants/x/guides/${G}/${F}.mp4`, 'a tenant that is not an id'],
  ])('refuses %s (%s)', (path) => {
    expect(served.test(path)).toBe(false);
  });

  it('answers with the type, no sniffing, nothing runnable, and keeps it a year', () => {
    expect(CONF).toMatch(/video\/mp4\s+mp4;/);
    expect(CONF).toMatch(/video\/webm\s+webm;/);
    expect(CONF).toMatch(/X-Content-Type-Options\s+nosniff/);
    expect(CONF).toMatch(/Content-Security-Policy\s+"default-src 'none'; sandbox"/);
    expect(CONF).toMatch(/Cache-Control\s+"public, max-age=31536000, immutable"/);
  });
});

describe("the in-network port the bot reads (F-414-f) serves guide files and nothing else", () => {
  it('reads a guide image or video by key', () => {
    expect(internalLocation?.test(`/tenants/${T}/guides/${G}/${F}.png`)).toBe(true);
    expect(internalLocation?.test(`/tenants/${T}/guides/${G}/${F}.mp4`)).toBe(true);
  });

  it.each([`/tenants/${T}/branding/${F}.png`, `/tenants/${T}/support/${G}/${F}.png`, `/tenants/${T}/guides/${G}/${F}.png.${F}.tmp`])('refuses %s', (path) => {
    expect(internalLocation?.test(path)).toBe(false);
  });

  it('is not the port Traefik routes', () => {
    expect(CONF).toMatch(/listen 8080;[\s\S]*listen 8081;/);
    expect(readFileSync(join(REPO, 'dev-docker/compose/guide-media.yml'), 'utf8')).toMatch(/loadbalancer\.server\.port=8080/);
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
