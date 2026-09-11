/**
 * Shared environment configuration for the landing site.
 *
 * `coinsite` has no locale wiring of its own — no locale-service client, no
 * cookie, no switcher (see `docs/interfaces/marketing-web/contract.md`). What
 * it does have is a language, and that language must be the platform's, not a
 * literal: `<html lang="en">` was hardcoded here while `.env` said
 * `DEFAULT_LANGUAGE=fa`, so the apex domain greeted every visitor in the wrong
 * language and in the wrong direction.
 *
 * `NEXT_PUBLIC_DEFAULT_LANGUAGE` is read first for the same reason as in
 * `site-pwa`: only `NEXT_PUBLIC_`-prefixed variables reach the browser bundle.
 * Compose feeds both names from the single `DEFAULT_LANGUAGE` in `.env`.
 */
export const DEFAULT_LOCALE: string =
  process.env.NEXT_PUBLIC_DEFAULT_LANGUAGE ||
  process.env.DEFAULT_LANGUAGE ||
  "fa";

/**
 * Right-to-left languages. `site-pwa` asks locale-service for a locale's `dir`;
 * this site has no client to ask, so it carries the list. Keep it in step with
 * the `dir` field in `metadata.json` under `locales/<scope>/langs/<code>/` — a
 * language added there and not here renders left-to-right on the landing page
 * only.
 */
const RTL_LANGUAGES = new Set(["fa", "ar", "he", "ur", "ps", "ckb"]);

export function dirOf(locale: string): "rtl" | "ltr" {
  const base = (locale || "").toLowerCase().split(/[-_]/)[0];
  return RTL_LANGUAGES.has(base) ? "rtl" : "ltr";
}

/** The direction the landing site renders in. */
export const DEFAULT_DIR = dirOf(DEFAULT_LOCALE);
