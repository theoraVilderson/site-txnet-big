import type { GuideBlock } from '@txnet-backend/shared-core';
import { describe, expect, it } from 'vitest';

import { guideSearchQuerySchema } from './guide-public.schema';
import type { ResolvedGuide } from './guide-reader';
import { GUIDE_SEARCH_MAX, normalizeForSearch, searchGuides } from './guide-search';

/**
 * Searching a tenant's guides (F-414-j). What breaks with nothing red anywhere:
 *  - **a Persian word not found because of how it was typed** — Arabic ي/ك
 *    from a phone keyboard, a half-space, or a diacritic: the guide is there
 *    and the search says nothing;
 *  - **another tenant's guide** — the search runs over the set the resolver
 *    already answers for this tenant, never a query of its own;
 *  - **Markdown in a snippet** — `**` and link targets shown as text.
 */
const g = (key: string, title: string, blocks: GuideBlock[], sortOrder = 0): ResolvedGuide => ({
  key,
  kind: 'app',
  owner: 'platform',
  lang: 'fa',
  title,
  blocks,
  sortOrder,
  updatedAt: '2026-10-04T00:00:00.000Z',
});

const GUIDES = [
  g('v2rayng', 'نصب v2rayNG روی اندروید', [{ type: 'text', text: 'برنامه را از **گوگل پلی** نصب کنید و [لینک](https://x.test/a) را وارد کنید.' }]),
  g('hiddify', 'Hiddify on iPhone', [{ type: 'steps', items: [{ text: 'Open the App Store' }, { text: 'Paste the subscription link' }] }]),
  g('refund', 'بازگشت وجه', [{ type: 'callout', tone: 'info', title: 'مهم', text: 'درخواست بازگشت وجه را از پشتیبانی بفرستید.' }]),
  g('screens', 'Subscription screens', [{ type: 'image', file: 'tenants/t/guides/g/a.png', alt: 'Subscription link screen' }]),
];

describe('normalizeForSearch', () => {
  it('reads Arabic letters, half-spaces, diacritics and case as the same word', () => {
    expect(normalizeForSearch('كيف‌پول')).toBe(normalizeForSearch('کیف پول'));
    expect(normalizeForSearch('مُهِم')).toBe('مهم');
    expect(normalizeForSearch('  V2RayNG  ')).toBe('v2rayng');
    expect(normalizeForSearch('۱۲۳')).toBe('123');
  });
});

describe('searchGuides', () => {
  it('finds a guide by its title, typed on an Arabic keyboard', () => {
    expect(searchGuides(GUIDES, 'نصب اندرويد').map((h) => h.key)).toEqual(['v2rayng']);
  });

  it('needs every word, anywhere in the title or the text', () => {
    expect(searchGuides(GUIDES, 'subscription paste').map((h) => h.key)).toEqual(['hiddify']);
    expect(searchGuides(GUIDES, 'subscription nothing')).toEqual([]);
  });

  it('reads steps, callouts and a picture’s description, and puts a title match first', () => {
    expect(searchGuides(GUIDES, 'subscription').map((h) => h.key)).toEqual(['screens', 'hiddify']);
    expect(searchGuides(GUIDES, 'پشتیبانی').map((h) => h.key)).toEqual(['refund']);
  });

  it('shows a snippet around the match, without Markdown', () => {
    const [hit] = searchGuides(GUIDES, 'گوگل');
    expect(hit.snippet).toContain('گوگل پلی');
    expect(hit.snippet).not.toMatch(/\*\*|https:|\]\(/);
    expect(hit).toEqual({ key: 'v2rayng', kind: 'app', lang: 'fa', title: GUIDES[0].title, snippet: hit.snippet });
  });

  it('answers at most a page', () => {
    const many = Array.from({ length: 30 }, (_, i) => g(`k${i}`, `Guide ${i}`, [{ type: 'text', text: 'router' }], i));
    expect(searchGuides(many, 'router')).toHaveLength(GUIDE_SEARCH_MAX);
  });
});

describe("searchGuides, any word (F-414-k: a support message's guides)", () => {
  it('finds a guide by one meaningful word of a whole sentence, more words first', () => {
    const message = 'سلام، وی پی ان روی اندرويد وصل نمیشه، لینک subscription هم زدم';
    expect(searchGuides(GUIDES, message, 'any').map((h) => h.key)).toEqual(['v2rayng', 'screens', 'hiddify']);
  });

  it('ignores short and common words, so a greeting matches nothing', () => {
    expect(searchGuides(GUIDES, 'سلام the and on is از به', 'any')).toEqual([]);
  });

  it('still needs every word by default', () => {
    expect(searchGuides(GUIDES, 'android nothing')).toEqual([]);
  });
});

describe('the query', () => {
  it('takes 2–100 characters, on one surface', () => {
    expect(guideSearchQuerySchema.parse({ q: ' vpn ' })).toEqual({ q: 'vpn', surface: 'panel', match: 'all' });
    expect(guideSearchQuerySchema.safeParse({ q: 'a' }).success).toBe(false);
    expect(guideSearchQuerySchema.safeParse({ q: 'x'.repeat(101) }).success).toBe(false);
    expect(guideSearchQuerySchema.safeParse({ q: 'vpn', surface: 'any' }).success).toBe(false);
    expect(guideSearchQuerySchema.parse({ q: 'vpn', match: 'any' })).toEqual({ q: 'vpn', surface: 'panel', match: 'any' });
  });
});
