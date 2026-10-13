import { describe, expect, it } from 'vitest';

import { foldForSearch, foldToOneSpelling, PERSIAN_STOP_WORDS, sameLetterPattern, transliterateToLatin } from './arabic-script';

// C-19 (CS-1-d): the backend's script tables live in one module; each caller
// keeps its own fold and none restates a letter.
describe('arabic-script', () => {
  it('saves one spelling: Arabic ي/ى/ك as Persian, every digit as ASCII, nothing else', () => {
    expect(foldToOneSpelling('علي كريم ۱۲٣')).toBe('علی کریم 123');
    expect(foldToOneSpelling('هة آ')).toBe('هة آ');
  });

  it('folds for search: hamza seats, ta marbuta, diacritics and tatweel too', () => {
    expect(foldForSearch('أإآؤة ي ك')).toBe('اااوه ی ک');
    expect(foldForSearch('مُحَمَّـد ۴')).toBe('محمد 4');
  });

  it('names every letter a search must not tell apart, and nothing for any other', () => {
    expect(new RegExp(sameLetterPattern('ي') ?? '').test('ئ')).toBe(true);
    expect(new RegExp(sameLetterPattern('ک') ?? '').test('ك')).toBe(true);
    expect(sameLetterPattern('ب')).toBeUndefined();
  });

  it('spells a Persian name in Latin letters, digits as ASCII', () => {
    expect(transliterateToLatin('شبکه ۲')).toBe('shbkh 2');
    expect(transliterateToLatin('abc')).toBe('abc');
  });

  it('keeps the stop words already folded, so a folded query finds them', () => {
    expect(PERSIAN_STOP_WORDS).toContain('سلام');
    for (const w of PERSIAN_STOP_WORDS) expect(foldForSearch(w)).toBe(w);
  });
});
