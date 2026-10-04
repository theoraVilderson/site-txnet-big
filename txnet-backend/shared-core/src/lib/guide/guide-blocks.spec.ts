import { describe, expect, it } from 'vitest';

import {
  GUIDE_BLOCK_TYPES,
  GUIDE_BLOCKS_MAX,
  guideBlocksSchema,
  guideFileKeys,
} from './guide-blocks';

/**
 * F-414-g (ADR-0116 point 1): a guide's text is an ordered array of typed
 * blocks. The schema is the one gate a writer passes; a file is an
 * object-storage key under `guides/`, never a URL.
 */

const T = '11111111-1111-4111-8111-111111111111';
const img = `tenants/${T}/guides/install_android/step1.png`;
const vid = `tenants/${T}/guides/install_android/demo.mp4`;
const poster = `tenants/${T}/guides/install_android/demo.jpg`;

const every = [
  { type: 'text', text: 'Install the **app** first.' },
  { type: 'image', file: img, alt: 'The store page' },
  { type: 'video', file: vid, poster, caption: 'Two minutes' },
  { type: 'steps', items: [{ text: 'Open the store' }, { text: 'Tap install', image: img }] },
  { type: 'callout', tone: 'warning', title: 'Before you start', text: 'Remove the old profile.' },
];

describe('guide blocks', () => {
  it('accepts one of each type, in order', () => {
    const parsed = guideBlocksSchema.parse(every);
    expect(parsed.map((b) => b.type)).toEqual([...GUIDE_BLOCK_TYPES]);
  });

  it('refuses an empty text and more than the cap', () => {
    expect(guideBlocksSchema.safeParse([]).success).toBe(false);
    const many = Array.from({ length: GUIDE_BLOCKS_MAX + 1 }, () => ({ type: 'text', text: 'x' }));
    expect(guideBlocksSchema.safeParse(many).success).toBe(false);
  });

  it('refuses an unknown type, an unknown field and an unknown callout tone', () => {
    expect(guideBlocksSchema.safeParse([{ type: 'html', text: '<b>' }]).success).toBe(false);
    expect(guideBlocksSchema.safeParse([{ type: 'text', text: 'x', html: '<b>' }]).success).toBe(false);
    expect(guideBlocksSchema.safeParse([{ type: 'callout', tone: 'pink', text: 'x' }]).success).toBe(false);
  });

  it('names a file by its storage key under guides/ — never a URL, never another path', () => {
    for (const file of [
      'https://cdn.example.com/a.png',
      `tenants/${T}/branding/logo`,
      `tenants/${T}/guides/../branding/logo`,
      'guides/a.png',
    ]) {
      expect(guideBlocksSchema.safeParse([{ type: 'image', file, alt: 'x' }]).success, file).toBe(false);
    }
    expect(guideBlocksSchema.safeParse([{ type: 'video', file: vid }]).success, 'a video needs a poster').toBe(false);
  });

  it('lists every file the blocks name, once', () => {
    expect(guideFileKeys(guideBlocksSchema.parse(every))).toEqual([img, vid, poster]);
  });
});
