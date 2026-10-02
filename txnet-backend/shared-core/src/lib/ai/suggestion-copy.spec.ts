import { existsSync, readdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { describe, expect, it } from 'vitest';
import { suggestionCopyVerdict } from './suggestion-copy';

/**
 * F-1507 (ADR-0109 point 10): one call to action per AI message, and no
 * artificial urgency, false scarcity or guilt — the same rule for a template
 * (the lint below) and for whatever text is about to leave (output validation).
 */
describe('suggestionCopyVerdict (F-1507)', () => {
  const plain = '💡 Suggestion: Home VPN ends in 3 days. Renew it to keep it running without a break — 120000 IRR for the next period.';

  it('passes a plain, factual suggestion with no button or one', () => {
    expect(suggestionCopyVerdict({ text: plain, ctas: 0 })).toEqual({ ok: true });
    expect(suggestionCopyVerdict({ text: plain, ctas: 1 })).toEqual({ ok: true });
  });

  it('refuses a second call to action, a link in the text counting as one', () => {
    expect(suggestionCopyVerdict({ text: plain, ctas: 2 })).toEqual({ ok: false, rule: 'cta' });
    expect(suggestionCopyVerdict({ text: `${plain} https://shop.example/renew`, ctas: 1 })).toEqual({ ok: false, rule: 'cta' });
    expect(suggestionCopyVerdict({ text: `${plain} https://shop.example/renew`, ctas: 0 })).toEqual({ ok: true });
    expect(suggestionCopyVerdict({ text: 'Renew at t.me/shopbot or www.shop.example', ctas: 0 })).toEqual({ ok: false, rule: 'cta' });
  });

  it.each([
    ['Hurry, renew today', 'urgency'],
    ['Renew now!', 'urgency'],
    ['Last chance to keep your plan', 'urgency'],
    ['Act now before it is too late', 'urgency'],
    ["Don't miss out on the next period", 'urgency'],
    ['همین الان تمدید کنید', 'urgency'],
    ['آخرین فرصت برای تمدید', 'urgency'],
    ['عجله کنید', 'urgency'],
    ['فقط امروز', 'urgency'],
    ['Only 3 left at this price', 'scarcity'],
    ['Limited spots for this plan', 'scarcity'],
    ['ظرفیت محدود است', 'scarcity'],
    ['فقط ۳ عدد باقی مانده', 'scarcity'],
    ["You'll regret losing your connection", 'guilt'],
    ['Don’t you want to stay connected?', 'guilt'],
    ['بعداً پشیمان می‌شوید', 'guilt'],
    ['حیف است سرویس قطع شود', 'guilt'],
  ])('refuses %j as %s', (text, rule) => {
    expect(suggestionCopyVerdict({ text, ctas: 0 })).toEqual({ ok: false, rule });
  });

  it('reads Persian through its zero-width joiner and Arabic letter forms', () => {
    expect(suggestionCopyVerdict({ text: 'پشيمان مي‌شويد', ctas: 0 })).toEqual({ ok: false, rule: 'guilt' });
  });

  it('a factual deadline is not urgency, and running out of traffic is not scarcity', () => {
    expect(suggestionCopyVerdict({ text: 'سرویس شما تا ۳ روز دیگر تمام می‌شود و حجم آن رو به اتمام است.', ctas: 1 })).toEqual({ ok: true });
  });
});

/** Walk up to the repo root — the spec must survive the unit moving. */
function repoRoot(): string {
  let dir = __dirname;
  while (!existsSync(join(dir, 'locales', 'backend', 'langs'))) {
    const up = dirname(dir);
    if (up === dir) throw new Error('locales/backend/langs not found above ' + __dirname);
    dir = up;
  }
  return dir;
}

describe('template lint: every language’s notifications.suggestion.* (F-1507)', () => {
  const langs = join(repoRoot(), 'locales', 'backend', 'langs');
  const templates = readdirSync(langs).flatMap((lang) => {
    const ns = JSON.parse(readFileSync(join(langs, lang, 'notifications.json'), 'utf8')) as { suggestion?: Record<string, string> };
    return Object.entries(ns.suggestion ?? {}).map(([key, text]) => [`${lang}:suggestion.${key}`, text] as const);
  });

  it('finds the suggestion templates', () => {
    expect(templates.length).toBeGreaterThanOrEqual(2 * 6);
  });

  it.each(templates)('%s holds the copy rule', (_key, text) => {
    expect(suggestionCopyVerdict({ text, ctas: 0 })).toEqual({ ok: true });
  });
});
