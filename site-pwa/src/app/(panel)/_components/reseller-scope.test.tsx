import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { clearOwnedResellersCache } from "../my-resellers/_lib/workspace";
import { ResellerWorkspaceProvider } from "../_context/ResellerWorkspaceContext";
import { PageHeader } from "./kit/PageHeader";

/**
 * Whose page it is (UX-2-a2, `contract.reseller-workspace.md`). An owner who
 * is also the platform's admin has two users pages, two catalogs, two
 * gateway lists. Data never crossed — each page is by its address's tenant —
 * but the header did not say whose, and `/reseller/users` was crumbed as the
 * platform's "users". One provider now decides whose reseller the address is
 * in, and every header reads it: no page opts in.
 */

const N = FrontendI18nKeys.common.resellerNav;
const S = FrontendI18nKeys.common.shell;
const BC = FrontendI18nKeys.common.kit.pageHeader.breadcrumb;

let pathname = "/";
let me: unknown = null;
// The setup row and its reads are UX-2-e's (`my-resellers/setup-progress.test.tsx`).
vi.mock("../_hooks/useResellerSetup", () => ({ useResellerSetup: () => ({ setup: null, reread: () => undefined }) }));
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));
vi.mock("@/context/LocaleContext", () => ({
  useLocale: () => ({ lang: "en", isRtl: false, t: (_ns: string, key: string) => key }),
}));
vi.mock("../_context/PanelSessionContext", () => ({ usePanelSession: () => ({ me, isLoading: false }) }));
let owned: unknown[] = [];
vi.mock("@/lib/auth-api", () => ({ authApi: { ownedResellers: vi.fn(async () => ({ resellers: owned })) } }));

const OWNER_ADMIN = { userId: "u-1", permissions: ["*"], tenant: { id: "t-platform", type: "platform_owner", isOwner: true } };
const SEAT = { userId: "u-2", permissions: ["domain.manage"], tenant: { id: "r-1", type: "reseller", isOwner: false } };
const ARIAN = { id: "r-1", slug: "arian", here: false, hasPanel: true, live: true };

const header = (tail?: string) =>
  render(
    <ResellerWorkspaceProvider>
      <PageHeader title="Page" tail={tail} />
    </ResellerWorkspaceProvider>,
  );

beforeEach(() => {
  clearOwnedResellersCache();
  me = OWNER_ADMIN;
  owned = [ARIAN];
});

describe("the page header says whose page it is", () => {
  it("tags a reseller's page with the reseller and its slug", async () => {
    pathname = "/reseller/users";
    header();
    const tag = (await screen.findByText("arian")).closest("p")!;
    expect(within(tag).getByText(N.scope)).toBeInTheDocument();
  });

  it("crumbs the reseller's users as the reseller's, not the platform's", async () => {
    pathname = "/reseller/users/u-9";
    header("Ali");
    await screen.findByText("arian");
    const trail = screen.getByRole("navigation", { name: BC });
    expect(within(trail).getByRole("link", { name: N.menu.users })).toHaveAttribute("href", "/reseller/users");
    // Under the one reseller button, as the menu draws it.
    expect(within(trail).getByText(N.scope)).toBeInTheDocument();
    expect(within(trail).queryByText(S.menu.users)).toBeNull();
  });

  it("does so for a staff seat on the reseller's domain too, whose account menu holds the same address", async () => {
    me = SEAT;
    owned = [];
    pathname = "/reseller/users/u-9";
    header("Ali");
    expect((await screen.findAllByText(N.scope)).length).toBeGreaterThan(0);
    expect(within(screen.getByRole("navigation", { name: BC })).getByRole("link", { name: N.menu.users })).toBeInTheDocument();
  });

  it("leaves the platform's own users page, at /users, the platform's", async () => {
    pathname = "/users/u-9";
    header("Ali");
    const trail = await screen.findByRole("navigation", { name: BC });
    expect(within(trail).getByRole("link", { name: S.menu.users })).toBeInTheDocument();
    expect(screen.queryByText(N.scope)).toBeNull();
  });

  it("tags nothing outside a workspace", async () => {
    pathname = "/catalog";
    header();
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText(N.scope)).toBeNull();
  });
});
