import type { GuideBlock } from '@txnet-backend/shared-core';

import type { ResolvedGuide } from './guide-reader';

/** One page of hits: a help sheet shows a list, not an archive. */
export const GUIDE_SEARCH_MAX = 20;

const SNIPPET_CHARS = 140;

/** A search result: enough to list it; the guide itself is read by key. */
export interface GuideHit {
  key: string;
  kind: string;
  lang: string;
  title: string;
  snippet: string;
}

/**
 * The same word however it was typed (F-414-j): lower case; Arabic ي/ى/ك/ة and
 * the hamza seats as the Persian letters; Persian and Arabic digits as ASCII;
 * no diacritics, tatweel or zero-width joiners (a half-space is a space); runs
 * of space as one.
 */
export function normalizeForSearch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[يى]/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/ة/g, 'ه')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ؤ/g, 'و')
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[​-‏⁠﻿]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A guide's words as a reader sees them: every text a block shows, Markdown's markers and link targets off. */
export function guideSearchText(blocks: readonly GuideBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === 'text') parts.push(b.text);
    else if (b.type === 'image') parts.push(b.alt, b.caption ?? '');
    else if (b.type === 'video') parts.push(b.caption ?? '');
    else if (b.type === 'steps') parts.push(...b.items.map((it) => it.text));
    else if (b.type === 'callout') parts.push(b.title ?? '', b.text);
  }
  return parts
    .join(' ')
    .replace(/\[([^\]\n]+)\]\([^)\s]+\)/g, '$1')
    .replace(/[*_`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Words that say nothing about which guide is meant (F-414-k): a greeting, a
 * pronoun, a particle. Dropped in `any` mode only — there a whole support
 * message is the query, and "سلام" would otherwise match every guide.
 */
const STOP_WORDS = new Set(
  normalizeForSearch(
    'سلام روی برای این اون آن که از به با را در تا هم من ما شما یک چرا چطور چه چی نمی میشه نمیشه کنم کنید دارم است هست ولی اما لطفا ممنون مرسی خیلی ' +
      'the and for you your with this that not does doesnt dont cant cannot have has was are but please hello thanks thank hey can how why what when',
  ).split(' '),
);

/** In `any` mode a word shorter than this is noise ("vp", "is", "از"). */
const ANY_MIN_WORD = 3;

/** How a query's words must be found: `all` for the search box, `any` for a support message. */
export const GUIDE_MATCHES = ['all', 'any'] as const;
export type GuideMatch = (typeof GUIDE_MATCHES)[number];

/**
 * The guides matching `query` in their title or text, at most a page.
 *
 * `all` (F-414-j, the search box): every word must be found; a title match
 * first, then the resolver's order. `any` (F-414-k, a support message): one
 * meaningful word is enough — short and common words dropped — ranked by how
 * many are found, a word in the title counting twice.
 *
 * Runs over the set `GuideReader` already resolved for this tenant, so it can
 * only find what the tenant may read.
 */
export function searchGuides(guides: readonly ResolvedGuide[], query: string, match: GuideMatch = 'all'): GuideHit[] {
  const normalized = normalizeForSearch(match === 'any' ? query.replace(/[^\p{L}\p{N}\s]+/gu, ' ') : query);
  const words = [...new Set(normalized.split(' ').filter(Boolean))].filter(
    (w) => match === 'all' || (w.length >= ANY_MIN_WORD && !STOP_WORDS.has(w)),
  );
  if (words.length === 0) return [];
  const scored: { hit: GuideHit; score: number; order: number }[] = [];
  guides.forEach((guide, order) => {
    const body = guideSearchText(guide.blocks);
    const title = normalizeForSearch(guide.title);
    const text = normalizeForSearch(body);
    const inTitle = words.filter((w) => title.includes(w));
    const found = words.filter((w) => title.includes(w) || text.includes(w));
    if (match === 'all' ? found.length < words.length : found.length === 0) return;
    const score = match === 'all' ? inTitle.length : found.length + inTitle.length;
    scored.push({ hit: { key: guide.key, kind: guide.kind, lang: guide.lang, title: guide.title, snippet: snippetOf(body, found) }, score, order });
  });
  return scored
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, GUIDE_SEARCH_MAX)
    .map((s) => s.hit);
}

/** About {@link SNIPPET_CHARS} characters of the text around the first word found in it; the start when none is. */
function snippetOf(body: string, words: string[]): string {
  if (body.length <= SNIPPET_CHARS) return body;
  const normalized = normalizeForSearch(body);
  // Normalizing keeps the length of everything but the characters it drops, so the
  // position is near enough to centre a window on.
  const at = Math.max(0, ...words.map((w) => normalized.indexOf(w)).filter((i) => i >= 0).slice(0, 1));
  const start = Math.max(0, at - SNIPPET_CHARS / 3);
  const slice = body.slice(start, start + SNIPPET_CHARS).trim();
  return `${start > 0 ? '…' : ''}${slice}${start + SNIPPET_CHARS < body.length ? '…' : ''}`;
}
