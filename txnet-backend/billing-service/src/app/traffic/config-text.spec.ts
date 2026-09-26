import { describe, expect, it } from 'vitest';
import { foldConfigText } from './config-text';

/**
 * A config's name is saved in one spelling (F-307-o, user 2026-09-26), so the
 * grant list's `q` can be a plain `contains`:
 *
 * > **ي and ى are ی, ك is ک, and Persian and Arabic digits are Latin** — on
 * > the label when it is saved, on `q` when it is asked, and on a default
 * > name when it is matched. Arabic and Persian keyboards type the same word
 * > with different letters, and "no service" for a name the user typed right
 * > is the bug.
 */
describe('foldConfigText', () => {
  it('writes the Arabic letters a Persian word is typed with as the Persian ones', () => {
    expect(foldConfigText('علي كرج')).toBe('علی کرج');
    expect(foldConfigText('مصطفى')).toBe('مصطفی');
  });

  it('writes Persian and Arabic digits as Latin', () => {
    expect(foldConfigText('سرور ۲۳')).toBe('سرور 23');
    expect(foldConfigText('خط ٤٥')).toBe('خط 45');
  });

  it('leaves everything else as typed — case, spaces, ZWNJ, Latin', () => {
    expect(foldConfigText('Home‌DE  2')).toBe('Home‌DE  2');
    expect(foldConfigText('آه')).toBe('آه');
  });
});
