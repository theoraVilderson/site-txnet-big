/**
 * Shared environment configuration — single source of truth.
 * Import this everywhere instead of scattering process.env reads.
 */

/**
 * The deployment's language, from `DEFAULT_LANGUAGE` in the environment — the
 * same variable `auth-service`, `bot-service` and `auth-handler` read, so one
 * knob sets the language every part of the platform answers a stranger in.
 *
 * `NEXT_PUBLIC_DEFAULT_LANGUAGE` is the client-visible mirror and is listed
 * first: this module is reachable from a "use client" component (`PhoneField`
 * -> `lib/phone`), and Next only inlines `NEXT_PUBLIC_`-prefixed variables into
 * the browser bundle. Without it the client half would silently fall back to
 * `fa` on a deployment that set `DEFAULT_LANGUAGE` to anything else. Compose
 * feeds both names from the single `DEFAULT_LANGUAGE` in `.env`.
 *
 * The `"fa"` last resort matches the backend's own default (`envSchema` in
 * `bot-service`, `config.go` in `auth-handler`), so an unset environment does
 * not split the platform in two.
 */
export const DEFAULT_LOCALE: string =
  process.env.NEXT_PUBLIC_DEFAULT_LANGUAGE ||
  process.env.DEFAULT_LANGUAGE ||
  "fa";

/** Where locale JSON files live inside the container (legacy; only locale-service reads them now) */
export const LOCALES_DIR = process.env.LOCALES_DIR || "./locales/langs";

/** Enable file watcher for hot-reload in dev (legacy; live reload now comes from locale-service) */
export const LOCALES_WATCH = process.env.LOCALES_WATCH === "true";

/** locale-service gRPC address (source of truth for translations) */
export const LOCALE_SERVICE_ADDR =
  process.env.LOCALE_SERVICE_ADDR || "localhost:50051";

/** Which slice of the locale tree this app needs */
export const LOCALE_SCOPE = process.env.LOCALE_SCOPE || "frontend";

/** Cookie name for user's locale preference */
export const LOCALE_COOKIE = "NEXT_LOCALE";

/** لیست تم‌های موجود — هر تم جدید فقط اینجا و در globals.css اضافه می‌شه */
export const AVAILABLE_THEMES = ["light", "dark", "ocean"] as const;
export type ThemeName = (typeof AVAILABLE_THEMES)[number];
export const DEFAULT_THEME: ThemeName = "dark";
export const THEME_COOKIE = "NEXT_THEME";

/**
 * The path the WebSocket gateway answers on (`platform/realtime`), on the
 * page's own host (`lib/api-origin.ts`, ADR-0060). `NEXT_PUBLIC_` because the
 * socket is opened only in the browser, and compose feeds it from the same
 * `REALTIME_PATH` the gateway and the Traefik router rule read. A path that
 * disagrees with that rule reaches a route the auth gate does not cover, which
 * is the one way to get an unauthenticated socket (`realtime/contract.md`).
 */
export const REALTIME_PATH = process.env.NEXT_PUBLIC_REALTIME_PATH || "/realtime";

/**
 * The HMAC key `billing`'s deposit callback signs the payment result with
 * (`payment/_lib/result-token.ts`). **Server only** — no `NEXT_PUBLIC_` mirror,
 * so it is `""` in any browser bundle. Empty means no result is ever shown and
 * every payer lands on the financial page.
 */
export const PAYMENT_RESULT_SECRET = process.env.PAYMENT_RESULT_SECRET || "";
