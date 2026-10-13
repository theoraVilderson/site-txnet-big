// @vitest-environment node
//
// FE-1-e: what a theme choice is, and how "system" becomes a theme, has one
// home. The client store, the server read and the pre-paint script used to
// each carry their own copy; these pin the copy they now share.
import { describe, expect, it } from 'vitest';
import { AVAILABLE_THEMES } from '@/env';
import { PREFERS_DARK_QUERY, isThemeName, resolveTheme } from './theme';
import { THEME_SCRIPT } from './theme-script';

describe('isThemeName', () => {
  it('accepts every configured theme', () => {
    for (const t of AVAILABLE_THEMES) expect(isThemeName(t)).toBe(true);
  });

  it('rejects "system", empty and unknown values', () => {
    for (const v of ['system', '', null, undefined, 'sepia']) {
      expect(isThemeName(v)).toBe(false);
    }
  });
});

describe('resolveTheme', () => {
  it('follows the system preference only for "system"', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });

  it('keeps an explicit choice whatever the system prefers', () => {
    for (const t of AVAILABLE_THEMES) {
      expect(resolveTheme(t, true)).toBe(t);
      expect(resolveTheme(t, false)).toBe(t);
    }
  });
});

it('the pre-paint script asks the same media query the provider listens to', () => {
  expect(THEME_SCRIPT).toContain(`'${PREFERS_DARK_QUERY}'`);
});
