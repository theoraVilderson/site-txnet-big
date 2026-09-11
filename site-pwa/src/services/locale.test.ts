// @vitest-environment node
//
// The panel half of F-046's rule: the deployment decides what language a
// stranger is answered in, not their browser. `getUserLocale` is a
// ("use server") action, so this spec stubs `next/headers` and the locale
// store rather than booting either.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const cookieValue = vi.fn<() => string | undefined>(() => undefined);
const headerValue = vi.fn<() => string | null>(() => null);

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieValue();
      return value === undefined ? undefined : { name, value };
    },
  }),
  headers: async () => ({ get: () => headerValue() }),
}));

const getAvailableLocales = vi.fn<() => string[]>(() => ['fa', 'en', 'ar']);
vi.mock('@/lib/locale-store', () => ({
  getAvailableLocales,
  ensureReady: async () => undefined,
}));
vi.mock('@/lib/locale-watcher', () => ({ startWatching: () => undefined }));

const getCurrentUserId = vi.fn<() => Promise<string | null>>(async () => null);
const getUserSavedLocale = vi.fn<() => Promise<string | null>>(async () => null);
vi.mock('@/services/user-locale-mock', () => ({
  getCurrentUserId,
  getUserSavedLocale,
  saveUserLocale: async () => undefined,
}));

/**
 * `DEFAULT_LOCALE` is read at module load, so each case re-imports the module
 * under the environment it is asserting about.
 */
async function localeUnder(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const { getUserLocale } = await import('./locale');
  return getUserLocale();
}

const CLEAN_ENV = {
  DEFAULT_LANGUAGE: undefined,
  NEXT_PUBLIC_DEFAULT_LANGUAGE: undefined,
};

describe('getUserLocale', () => {
  beforeEach(() => {
    cookieValue.mockReturnValue(undefined);
    headerValue.mockReturnValue(null);
    getCurrentUserId.mockResolvedValue(null);
    getUserSavedLocale.mockResolvedValue(null);
    getAvailableLocales.mockReturnValue(['fa', 'en', 'ar']);
  });

  // The defect this item exists for: the panel used to consult Accept-Language
  // before the deployment default, so an English browser opened a Persian
  // deployment in English on the very first request.
  it('answers a first visit in DEFAULT_LANGUAGE, whatever the browser asks for', async () => {
    headerValue.mockReturnValue('en-US,en;q=0.9');
    await expect(localeUnder({ ...CLEAN_ENV, DEFAULT_LANGUAGE: 'fa' })).resolves.toBe('fa');
  });

  it('follows DEFAULT_LANGUAGE when it is not fa', async () => {
    headerValue.mockReturnValue('fa-IR,fa;q=0.9');
    await expect(localeUnder({ ...CLEAN_ENV, DEFAULT_LANGUAGE: 'en' })).resolves.toBe('en');
  });

  it('falls back to fa when DEFAULT_LANGUAGE is unset, matching the backend default', async () => {
    await expect(localeUnder({ ...CLEAN_ENV })).resolves.toBe('fa');
  });

  it('lets NEXT_PUBLIC_DEFAULT_LANGUAGE stand in, so client and server agree', async () => {
    await expect(
      localeUnder({ ...CLEAN_ENV, NEXT_PUBLIC_DEFAULT_LANGUAGE: 'ar' }),
    ).resolves.toBe('ar');
  });

  // The two things that still outrank the deployment: they are choices a
  // person made, not a guess made on their behalf.
  it('lets the cookie outrank DEFAULT_LANGUAGE', async () => {
    cookieValue.mockReturnValue('en');
    await expect(localeUnder({ ...CLEAN_ENV, DEFAULT_LANGUAGE: 'fa' })).resolves.toBe('en');
  });

  it("lets a signed-in user's saved language outrank the cookie", async () => {
    cookieValue.mockReturnValue('en');
    getCurrentUserId.mockResolvedValue('u-1');
    getUserSavedLocale.mockResolvedValue('ar');
    await expect(localeUnder({ ...CLEAN_ENV, DEFAULT_LANGUAGE: 'fa' })).resolves.toBe('ar');
  });
});

/**
 * The block above stubs `user-locale-mock`. This one pins the real thing,
 * because it sits at rank 1 and a wrong answer there outranks every fix in
 * `getUserLocale`: the mock used to report a signed-in user unconditionally
 * (`"useruid"`) and seed that user's language as `"en"`, so *every* anonymous
 * visitor was served English before the cookie or the deployment default was
 * ever consulted.
 */
describe('user-locale-mock (the real module)', () => {
  it('reports nobody signed in — there is no real session yet', async () => {
    vi.resetModules();
    const real = await vi.importActual<typeof import('./user-locale-mock')>(
      './user-locale-mock',
    );
    await expect(real.getCurrentUserId()).resolves.toBeNull();
  });

  it('seeds no language for anyone, so no visitor inherits a stranger\'s', async () => {
    vi.resetModules();
    const real = await vi.importActual<typeof import('./user-locale-mock')>(
      './user-locale-mock',
    );
    await expect(real.getUserSavedLocale('useruid')).resolves.toBeNull();
  });
});
