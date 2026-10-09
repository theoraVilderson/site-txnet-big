import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FrontendI18nKeys } from "@/generated/i18n-keys";

/**
 * AC-1-i: "sign in as this user" (catalog §3.6, ADR-0136/0137). The button
 * sits on one user's page and follows the server's own `canAct` — so never
 * the owner, never yourself — plus the key the route asks; the reason is at
 * least 10 characters; a banner on every page counts the 30 minutes down and
 * ends it; the menu shows only the account section meanwhile.
 */

const K = FrontendI18nKeys.common.impersonation;

const { router, state, session } = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn() },
  state: { current: null as null | { userId: string; name: string; endsAt: number; returnTo: string } },
  session: { me: { permissions: ["user.impersonate"], tenant: { id: "p-1", type: "platform_owner", isOwner: false } } as unknown },
}));
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/users/u-9" }));
vi.mock("@/context/LocaleContext", () => ({
  useLocale: () => ({ lang: "en", isRtl: false, t: (_ns: string, key: string, vars?: object) => (vars ? `${key} ${JSON.stringify(vars)}` : key) }),
}));
vi.mock("@/hooks/useMotionLevel", () => ({ useMotionLevel: () => "reduced" }));
vi.mock("./_context/PanelSessionContext", () => ({ usePanelSession: () => ({ me: session.me, isLoading: false }) }));
vi.mock("@/lib/auth-api", () => ({
  authApi: {
    impersonate: vi.fn(async () => undefined),
    endImpersonation: vi.fn(async () => {
      state.current = null;
    }),
    endImpersonationOnUnload: vi.fn(),
    impersonation: () => state.current,
    onImpersonationChange: () => () => undefined,
  },
}));

import { authApi } from "@/lib/auth-api";
import { ApiError } from "@/lib/api-error";
import { ImpersonationBanner, impersonationTimeLeft } from "./_components/ImpersonationBanner";
import { SignInAsUser, mayImpersonate } from "./_components/SignInAsUser";
import { impersonationMenu } from "./_lib/panel-menu";

beforeEach(() => {
  vi.clearAllMocks();
  state.current = null;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the button", () => {
  const me = (permissions: string[]) => ({ permissions }) as never;

  it("follows canAct and the key the route asks", () => {
    expect(mayImpersonate({ canAct: true, status: "active" }, me(["user.impersonate"]), false)).toBe(true);
    expect(mayImpersonate({ canAct: true, status: "active" }, me(["platform.impersonate"]), true)).toBe(true);
    expect(mayImpersonate({ canAct: true, status: "active" }, me(["*"]), true)).toBe(true);
    // No authority — the owner, yourself, a peer holding as much (ADR-0103, ADR-0137).
    expect(mayImpersonate({ canAct: false, status: "active" }, me(["*"]), false)).toBe(false);
    expect(mayImpersonate({ canAct: true, status: "active" }, me(["platform.impersonate"]), false)).toBe(false);
    expect(mayImpersonate({ canAct: true, status: "active" }, me(["user.impersonate"]), true)).toBe(false);
    expect(mayImpersonate({ canAct: true, status: "suspended" }, me(["*"]), false)).toBe(false);
    expect(mayImpersonate({ canAct: true, status: "active" }, null, false)).toBe(false);
  });

  it("asks a reason of at least 10 characters, then signs in and opens the home page", async () => {
    render(<SignInAsUser userId="u-9" name="Sara" tenantId={null} returnTo="/users/u-9" />);
    fireEvent.click(screen.getByText(K.start));
    const dialog = await screen.findByRole("dialog");
    const go = within(dialog).getByText(K.confirm).closest("button")!;

    fireEvent.change(within(dialog).getByLabelText(K.reason), { target: { value: "  too short " } });
    expect(go).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(K.reason), { target: { value: "ticket 4417: top-up fails" } });
    expect(go).not.toBeDisabled();
    fireEvent.click(go);

    await waitFor(() =>
      expect(authApi.impersonate).toHaveBeenCalledWith({
        userId: "u-9",
        name: "Sara",
        reasonNote: "ticket 4417: top-up fails",
        tenantId: null,
        returnTo: "/users/u-9",
      }),
    );
    expect(router.push).toHaveBeenCalledWith("/");
  });

  it("shows the server's sentence when it refuses, and stays", async () => {
    vi.mocked(authApi.impersonate).mockRejectedValueOnce(new ApiError("No consent", { status: 403, reason: "consent_required" }));
    render(<SignInAsUser userId="u-9" name="Sara" tenantId="r-1" returnTo="/my-resellers/r-1/users/u-9" />);
    fireEvent.click(screen.getByText(K.start));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(K.reason), { target: { value: "ticket 4417: top-up fails" } });
    fireEvent.click(within(dialog).getByText(K.confirm));
    expect(await within(dialog).findByText("No consent")).toBeTruthy();
    expect(router.push).not.toHaveBeenCalled();
  });
});

describe("the banner", () => {
  it("is drawn only while signed in as someone", () => {
    const { container } = render(<ImpersonationBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it("names the person, counts the time down, and ends it back on the page it started from", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    state.current = { userId: "u-9", name: "Sara", endsAt: Date.now() + 90_000, returnTo: "/users/u-9" };
    render(<ImpersonationBanner />);
    expect(screen.getByText(`${K.banner} {"name":"Sara"}`)).toBeTruthy();
    expect(screen.getByText(`${K.timeLeft} {"time":"01:30"}`)).toBeTruthy();

    fireEvent.click(screen.getByText(K.end));
    await waitFor(() => expect(authApi.endImpersonation).toHaveBeenCalled());
    expect(router.push).toHaveBeenCalledWith("/users/u-9");
  });

  it("ends it by itself when the 30 minutes run out", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    state.current = { userId: "u-9", name: "Sara", endsAt: Date.now() + 2_000, returnTo: "/users/u-9" };
    render(<ImpersonationBanner />);
    await act(async () => {
      vi.advanceTimersByTime(3_000);
    });
    await waitFor(() => expect(authApi.endImpersonation).toHaveBeenCalled());
    expect(router.push).toHaveBeenCalledWith("/users/u-9");
  });

  it("reads mm:ss, never below zero", () => {
    expect(impersonationTimeLeft(1_800_000, "en")).toBe("30:00");
    expect(impersonationTimeLeft(61_500, "en")).toBe("01:01");
    expect(impersonationTimeLeft(-5, "en")).toBe("00:00");
    expect(impersonationTimeLeft(90_000, "fa")).toBe("۰۱:۳۰");
  });
});

describe("the menu while signed in as someone", () => {
  it("keeps the account section and settings, and drops the rest", () => {
    const entries = [
      { id: "home" },
      { id: "wallet", section: "account" },
      { id: "coupons", section: "sales" },
      { id: "users", section: "people" },
      { id: "settings", section: "footer" },
    ] as never[];
    expect(impersonationMenu(entries).map((e: { id: string }) => e.id)).toEqual(["home", "wallet", "settings"]);
  });
});
