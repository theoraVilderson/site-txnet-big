import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The module keeps one load per page, so every case gets a fresh one. */
async function load() {
  vi.resetModules();
  return import("./mini-app");
}

const MINI_APP_PARAM = "ma";

/** Asserted verbatim: each is what that platform's own documentation prints. */
const SDK = {
  telegram: "https://telegram.org/js/telegram-web-app.js?63",
  bale: "https://tapi.bale.ai/miniapp.js?3",
} as const;

/**
 * The half of `F-310` that runs in the browser (ADR-0017).
 *
 * The bug these cover: neither platform injects `window.<X>.WebApp` on its
 * own — the page has to load that platform's SDK — so a panel that only *read*
 * the global found nothing in a real webview and sent every Mini App visitor
 * to the login screen. The marker in the URL is what says which SDK to load,
 * and loading none at all is the correct answer for an ordinary browser.
 */

/** Stand in for the script the platform serves: define the global on load. */
function serveSdk(define: () => void, { fail = false } = {}) {
  const originalAppend = document.head.appendChild.bind(document.head);
  return vi
    .spyOn(document.head, "appendChild")
    .mockImplementation(((node: any) => {
      const result = originalAppend(node);
      queueMicrotask(() => {
        if (fail) {
          node.onerror?.(new Event("error"));
          return;
        }
        define();
        node.onload?.(new Event("load"));
      });
      return result;
    }) as typeof document.head.appendChild);
}

function visit(search: string) {
  window.history.replaceState({}, "", `/dashboard${search}`);
}

const ready = vi.fn();
const expand = vi.fn();

beforeEach(() => {
  vi.resetModules();
  visit("");
  delete (window as any).Telegram;
  delete (window as any).Bale;
  for (const script of Array.from(document.querySelectorAll("script"))) {
    script.remove();
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("miniAppPlatform", () => {
  it("reads the marker the bot put on the URL", async () => {
    visit(`?${MINI_APP_PARAM}=telegram`);
    expect((await load()).miniAppPlatform()).toBe("telegram");
    visit(`?${MINI_APP_PARAM}=bale`);
    expect((await load()).miniAppPlatform()).toBe("bale");
  });

  it("is null for an ordinary visit, and for a marker nobody serves", async () => {
    visit("");
    expect((await load()).miniAppPlatform()).toBeNull();
    visit(`?${MINI_APP_PARAM}=whatsapp`);
    expect((await load()).miniAppPlatform()).toBeNull();
  });

  it("survives the other query the page already carries", async () => {
    visit(`?next=%2Fplans&${MINI_APP_PARAM}=telegram`);
    expect((await load()).miniAppPlatform()).toBe("telegram");
  });
});

describe("miniAppHost", () => {
  it("loads that platform's SDK and returns what it signed", async () => {
    visit(`?${MINI_APP_PARAM}=telegram`);
    const append = serveSdk(() => {
      (window as any).Telegram = {
        WebApp: { initData: "user=%7B%22id%22%3A7%7D&hash=abc", ready, expand },
      };
    });

    const host = await (await load()).miniAppHost();

    expect(host).not.toBeNull();
    expect(host!.platform).toBe("telegram");
    // Verbatim: the signature covers this string, so re-encoding it forges it.
    expect(host!.initData).toBe("user=%7B%22id%22%3A7%7D&hash=abc");
    expect(append).toHaveBeenCalled();
    expect(document.querySelector("script")?.getAttribute("src")).toBe(
      SDK.telegram,
    );
  });

  it("loads Bale's own script, not Telegram's", async () => {
    visit(`?${MINI_APP_PARAM}=bale`);
    serveSdk(() => {
      (window as any).Bale = { WebApp: { initData: "hash=b", ready, expand } };
    });

    const host = await (await load()).miniAppHost();

    expect(host!.platform).toBe("bale");
    expect(document.querySelector("script")?.getAttribute("src")).toBe(
      SDK.bale,
    );
  });

  it("loads nothing at all for an ordinary browser", async () => {
    visit("");
    const append = serveSdk(() => {
      (window as any).Telegram = { WebApp: { initData: "hash=a" } };
    });

    expect(await (await load()).miniAppHost()).toBeNull();
    expect(append).not.toHaveBeenCalled();
  });

  it("loads the script once, however many times it is asked", async () => {
    visit(`?${MINI_APP_PARAM}=telegram`);
    const append = serveSdk(() => {
      (window as any).Telegram = { WebApp: { initData: "hash=a", ready } };
    });

    const mod = await load();
    await Promise.all([mod.miniAppHost(), mod.miniAppHost()]);
    await mod.miniAppHost();

    expect(append).toHaveBeenCalledTimes(1);
  });

  it("tells the host the page is painted, and takes the full height", async () => {
    visit(`?${MINI_APP_PARAM}=telegram`);
    serveSdk(() => {
      (window as any).Telegram = {
        WebApp: { initData: "hash=a", ready, expand },
      };
    });

    (await (await load()).miniAppHost())!.ready();

    expect(ready).toHaveBeenCalled();
    expect(expand).toHaveBeenCalled();
  });

  it("is still a host when it implements neither", async () => {
    visit(`?${MINI_APP_PARAM}=telegram`);
    serveSdk(() => {
      (window as any).Telegram = { WebApp: { initData: "hash=a" } };
    });

    const host = await (await load()).miniAppHost();

    expect(() => host!.ready()).not.toThrow();
  });

  it("is null when the script never arrives", async () => {
    visit(`?${MINI_APP_PARAM}=telegram`);
    serveSdk(() => undefined, { fail: true });

    // A blocked or unreachable CDN is the ordinary login screen, never a hang.
    expect(await (await load()).miniAppHost()).toBeNull();
  });

  it("is null when the SDK loads but the host signed nothing", async () => {
    visit(`?${MINI_APP_PARAM}=telegram`);
    serveSdk(() => {
      // Re-opened from the host's cache, or an inline button in a group.
      (window as any).Telegram = { WebApp: { initData: "" } };
    });

    expect(await (await load()).miniAppHost()).toBeNull();
  });
});
