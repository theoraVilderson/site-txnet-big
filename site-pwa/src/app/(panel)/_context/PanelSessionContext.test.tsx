import { StrictMode, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import type { authApi as AuthApi } from "@/lib/auth-api";

/**
 * The page load's hold (`authApi.holdUntilSession`): a child that fetches on
 * mount — the sidebar's "my reseller panel" asking `GET /auth/handoff` — runs
 * its effect before the provider's, and must not go out tokenless to be
 * refused 401. Rendered under `StrictMode`, as `next dev` does: its simulated
 * unmount must not release a call the first mount held.
 */

const nav = vi.hoisted(() => ({ replace: vi.fn(), host: null as unknown }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: nav.replace }) }));
vi.mock("@/lib/mini-app", () => ({ miniAppHost: vi.fn(async () => nav.host) }));

let fetchMock: ReturnType<typeof vi.fn>;
let authApi: typeof AuthApi;
let PanelSessionProvider: typeof import("./PanelSessionContext").PanelSessionProvider;

const ok = (data: unknown) =>
  new Response(JSON.stringify({ ok: true, data }), { status: 200, headers: { "content-type": "application/json" } });

beforeEach(async () => {
  vi.resetModules();
  fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith("/auth/refresh")) {
      await new Promise((r) => setTimeout(r, 20));
      return ok({ accessToken: "h.eyJzdWIiOiJ1LTEifQ.s", expiresIn: 900 });
    }
    return ok({ resellers: [], groupId: null, current: null, members: [] });
  });
  vi.stubGlobal("fetch", fetchMock);
  ({ authApi } = await import("@/lib/auth-api"));
  ({ PanelSessionProvider } = await import("./PanelSessionContext"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  nav.host = null;
  nav.replace.mockClear();
});

function SidebarEntry() {
  useEffect(() => {
    void authApi.ownedResellers().catch(() => undefined);
  }, []);
  return null;
}

describe("the panel's page load", () => {
  it("sends a child's on-mount call only with the session's token, even under StrictMode", async () => {
    render(
      <StrictMode>
        <PanelSessionProvider>
          <SidebarEntry />
        </PanelSessionProvider>
      </StrictMode>,
    );

    const handoff = () => fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/auth/handoff"));
    await waitFor(() => expect(handoff().length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 50));
    for (const [, init] of handoff()) {
      expect(new Headers((init as RequestInit).headers).get("authorization")).toMatch(/^Bearer /);
    }
  });
});

describe("the Mini App, for an account the messenger alone does not sign in (SA-1-e)", () => {
  it("goes to the Mini App's password page, not the login screen", async () => {
    nav.host = { platform: "telegram", initData: "signed", ready: () => undefined };
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith("/auth/bots/webapp/session")
        ? ok({ state: "needsPassword" })
        : new Response(JSON.stringify({ ok: false, msg: "auth.invalidRefreshToken" }), { status: 401, headers: { "content-type": "application/json" } }),
    );
    render(<PanelSessionProvider>{null}</PanelSessionProvider>);
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/auth/mini-app"));
  });
});
