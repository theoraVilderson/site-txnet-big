import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { ApiError } from "@/lib/api-error";
import { FormError } from "@auth/auth/_components/FormError";
import { banDetail } from "@auth/auth/_hooks/useSubmitError";
import { PanelShell } from "./_components/PanelShell";

/**
 * BAN-1-e (ADR-0133). A restricted person used to be told "wrong password";
 * now they sign in and the panel is one screen — the reason staff wrote and
 * their own support conversations. Every other page sends them to support
 * (the server refuses it anyway; this is so they never see a wall of errors).
 * A banned person is told so at sign-in, with the reason under the message.
 */

const R = FrontendI18nKeys.common.restricted;
const nav = vi.hoisted(() => ({ path: "/", replace: vi.fn() }));
let me: unknown = null;

vi.mock("next/navigation", () => ({
  usePathname: () => nav.path,
  useRouter: () => ({ replace: nav.replace, push: vi.fn() }),
}));
vi.mock("@/context/LocaleContext", () => ({
  useLocale: () => ({ lang: "en", isRtl: false, t: (_ns: string, key: string) => key }),
}));
vi.mock("./_context/PanelSessionContext", () => ({ usePanelSession: () => ({ me, isLoading: false }) }));
vi.mock("./_components/PanelSidebar", () => ({ PanelSidebar: () => <nav>full sidebar</nav> }));
vi.mock("./_components/PanelTopBar", () => ({ PanelTopBar: () => <header>full top bar</header> }));
vi.mock("./_components/CommandPalette", () => ({ CommandPalette: () => null }));
vi.mock("./_components/RouteProgress", () => ({ RouteProgress: () => null }));
vi.mock("./_components/AccountSwitcher", () => ({ AccountSwitcher: () => <div>switcher</div> }));
vi.mock("./_components/LogoutButton", () => ({ LogoutButton: () => <button type="button">logout</button> }));

const restricted = (reason: string | null) => ({ userId: "u-1", permissions: [], restriction: { reason } });

beforeEach(() => {
  vi.clearAllMocks();
  nav.path = "/";
});

describe("a restricted account (ADR-0133)", () => {
  it("shows the reason and its own support pages, without the panel around them", () => {
    me = restricted("unpaid invoice 1042");
    nav.path = "/support/c-1";

    render(<PanelShell><p>thread</p></PanelShell>);

    expect(screen.getByText(R.title)).toBeTruthy();
    expect(screen.getByText("unpaid invoice 1042")).toBeTruthy();
    expect(screen.getByText("thread")).toBeTruthy();
    expect(screen.getByText("logout")).toBeTruthy();
    expect(screen.queryByText("full sidebar")).toBeNull();
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it.each(["/", "/services", "/support/inbox", "/support/settings"])("sends %s to support and draws nothing of it", (path) => {
    me = restricted(null);
    nav.path = path;

    render(<PanelShell><p>page</p></PanelShell>);

    expect(nav.replace).toHaveBeenCalledWith("/support");
    expect(screen.queryByText("page")).toBeNull();
    expect(screen.getByText(R.noReason)).toBeTruthy();
  });

  it("leaves an unrestricted account its whole panel", () => {
    me = { userId: "u-1", permissions: [], restriction: null };
    render(<PanelShell><p>page</p></PanelShell>);
    expect(screen.getByText("full sidebar")).toBeTruthy();
    expect(screen.getByText("page")).toBeTruthy();
  });
});

describe("a banned account at sign-in (ADR-0133)", () => {
  it("puts the reason under the message", () => {
    const e = new ApiError("This account has been banned", {
      status: 200,
      reason: "accountBanned",
      facts: { statusReason: "resold accounts" },
    });
    render(<FormError message={e.message} detail={banDetail(e)} />);
    expect(screen.getByText("This account has been banned")).toBeTruthy();
    expect(screen.getByText("resold accounts")).toBeTruthy();
  });

  it("adds nothing for any other refusal", () => {
    expect(banDetail(new ApiError("wrong", { status: 200, reason: "x", facts: { statusReason: "y" } }))).toBeUndefined();
  });
});
