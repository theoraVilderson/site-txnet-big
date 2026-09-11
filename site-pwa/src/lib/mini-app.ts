/**
 * The panel, running inside a messenger's Mini App (`F-310`).
 *
 * This whole file is one question: *is this page a webview a messenger opened,
 * and if so what did that messenger sign?* Everything else about the panel is
 * unchanged — the Mini App is this app, not a second one (ADR-0009), so there
 * is no Mini App layout, no Mini App route and no Mini App branch below this
 * module.
 *
 * The two platforms differ by the name of one global and the URL of one script
 * and nothing else (`docs/platform/messenger/contract.md`, verified
 * 2026-09-10), so the table below is the entire per-platform surface this app
 * has.
 *
 * **Neither platform injects its global on its own.** Both serve a script the
 * page has to load; reading `window.Telegram` without it finds nothing in a
 * real webview, which is why the Mini App sent everyone to the login screen
 * until 2026-09-10. Which script to load is not guessable from inside the
 * page, so the bot says it: the `web_app` row carries `?ma=<platform>` on the
 * URL it hands over (`docs/interfaces/bot-app/contract.md`). The marker is a
 * hint, never a credential — the signature is still the only thing the server
 * accepts, and a forged marker only picks the wrong script.
 */

export type MiniAppPlatform = "telegram" | "bale";

type WebAppGlobal = {
  initData?: string;
  ready?: () => void;
  expand?: () => void;
};

/** The query parameter the bot's `web_app` row puts on `PANEL_BASE_URL`. */
export const MINI_APP_PARAM = "ma";

/**
 * Each platform's own SDK, read from its own documentation on **2026-09-10**:
 * [core.telegram.org/bots/webapps](https://core.telegram.org/bots/webapps),
 * [docs.bale.ai/miniapp](https://docs.bale.ai/miniapp). The version suffix is
 * part of the URL each publishes — kept verbatim, not trimmed.
 */
export const MINI_APP_SDK: Record<MiniAppPlatform, string> = {
  telegram: "https://telegram.org/js/telegram-web-app.js?63",
  bale: "https://tapi.bale.ai/miniapp.js?3",
};

/** Global object name per platform. Differs by name only. */
const GLOBAL: Record<MiniAppPlatform, [string, string]> = {
  telegram: ["Telegram", "WebApp"],
  bale: ["Bale", "WebApp"],
};

export type MiniAppHost = {
  platform: MiniAppPlatform;
  /** The signed string, verbatim. Never re-encoded — the signature covers it. */
  initData: string;
  /** Tell the host the page is painted, and use the full height. */
  ready: () => void;
};

/**
 * Which messenger opened this page, according to the URL the bot handed over.
 *
 * `null` for an ordinary browser — and also for a marker naming a platform
 * this app has no SDK for, because a value we cannot act on and a value that
 * is not there are the same answer.
 */
export function miniAppPlatform(): MiniAppPlatform | null {
  if (typeof window === "undefined") return null;
  const marker = new URLSearchParams(window.location.search).get(
    MINI_APP_PARAM,
  );
  return marker && marker in MINI_APP_SDK
    ? (marker as MiniAppPlatform)
    : null;
}

/** One load per page, however many callers ask. */
const loading = new Map<MiniAppPlatform, Promise<boolean>>();

/**
 * Load a platform's SDK and resolve once its global is there.
 *
 * `false` rather than a throw when the script does not arrive: a blocked,
 * filtered or simply unreachable CDN is a page that cannot prove who is
 * looking, which is the ordinary login screen — the same answer as no host at
 * all, and never a hang.
 */
function loadSdk(platform: MiniAppPlatform): Promise<boolean> {
  const already = loading.get(platform);
  if (already) return already;

  const pending = new Promise<boolean>((resolve) => {
    const script = document.createElement("script");
    script.src = MINI_APP_SDK[platform];
    script.async = true;
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.head.appendChild(script);
  });
  loading.set(platform, pending);
  return pending;
}

/** The global that SDK defines, or `undefined` if it defined none. */
function readGlobal(platform: MiniAppPlatform): WebAppGlobal | undefined {
  const [namespace, key] = GLOBAL[platform];
  return (window as any)?.[namespace]?.[key] as WebAppGlobal | undefined;
}

/**
 * The messenger hosting this page, or `null` for an ordinary browser.
 *
 * `initData` empty is a real and expected state, not a bug: a Mini App opened
 * from an inline button in a group, or re-opened from the host's own cache,
 * can carry none. It means "this host cannot prove who is looking", which is
 * the same answer as no host at all — the visitor signs in the ordinary way.
 */
export async function miniAppHost(): Promise<MiniAppHost | null> {
  const platform = miniAppPlatform();
  if (!platform) return null;
  if (!(await loadSdk(platform))) return null;

  const app = readGlobal(platform);
  if (!app || typeof app.initData !== "string" || !app.initData) return null;

  return {
    platform,
    initData: app.initData,
    ready: () => {
      try {
        app.ready?.();
        app.expand?.();
      } catch {
        // A host that does not implement these is still a host. The page
        // renders either way, and failing here would be the one thing that
        // stops it.
      }
    },
  };
}
