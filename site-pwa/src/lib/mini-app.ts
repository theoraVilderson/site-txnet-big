/**
 * The panel, running inside a messenger's Mini App (`F-310`).
 *
 * This whole file is one question: *is this page a webview a messenger opened,
 * and if so what did that messenger sign?* Everything else about the panel is
 * unchanged — the Mini App is this app, not a second one (ADR-0009), so there
 * is no Mini App layout, no Mini App route and no Mini App branch below this
 * module.
 *
 * The two platforms differ by the name of one global and nothing else
 * (`docs/platform/messenger/contract.md`, verified 2026-09-05), so the list
 * below is the entire per-platform surface this app has.
 */

export type MiniAppPlatform = "telegram" | "bale";

type WebAppGlobal = {
  initData?: string;
  ready?: () => void;
  expand?: () => void;
};

/** Global name -> platform, in the order they are looked for. */
const GLOBALS: Array<{ platform: MiniAppPlatform; path: [string, string] }> = [
  { platform: "telegram", path: ["Telegram", "WebApp"] },
  { platform: "bale", path: ["Bale", "WebApp"] },
];

export type MiniAppHost = {
  platform: MiniAppPlatform;
  /** The signed string, verbatim. Never re-encoded — the signature covers it. */
  initData: string;
  /** Tell the host the page is painted, and use the full height. */
  ready: () => void;
};

/**
 * The messenger hosting this page, or `null` for an ordinary browser.
 *
 * `initData` empty is a real and expected state, not a bug: a Mini App opened
 * from an inline button in a group, or re-opened from the host's own cache,
 * can carry none. It means "this host cannot prove who is looking", which is
 * the same answer as no host at all — the visitor signs in the ordinary way.
 */
export function miniAppHost(): MiniAppHost | null {
  if (typeof window === "undefined") return null;

  for (const { platform, path } of GLOBALS) {
    const [namespace, key] = path;
    const app = (window as any)?.[namespace]?.[key] as WebAppGlobal | undefined;
    if (!app || typeof app.initData !== "string" || !app.initData) continue;
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
  return null;
}
