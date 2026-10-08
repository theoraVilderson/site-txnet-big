import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PANEL_MY_RESELLERS,
  myResellerConsolePath,
  myResellerGatewaysPath,
  myResellerUserPath,
  selfWorkspacePath,
} from "@/lib/routes";
import { clearOwnedResellersCache, resellerDomainOf, selfResellerOf } from "./_lib/workspace";
import { stepHref } from "./_lib/onboarding";
import { SelfWorkspace } from "../reseller/_components/SelfWorkspace";
import { PlatformOnlyWorkspace } from "./_components/PlatformOnlyWorkspace";
import { PANEL_MENU, isMenuGroup, menuTrail, visibleMenu } from "../_lib/panel-menu";

/**
 * A reseller's workspace on its own domain (F-061-n), at the id-less
 * `/reseller`: `/my-resellers/<uuid>` on a customer-facing domain gave away how
 * the platform addresses — and manages — the reseller.
 *
 * **The owner's session there is the platform's tenant** (ADR-0059: the handoff
 * signs the same account in, branded by the door). So "this is my reseller's
 * domain" is `here` on `GET /auth/handoff`, never `me.tenant` — the first
 * version read `me.tenant` alone and the owner, the one person this is for,
 * still saw `/my-resellers/<uuid>` (user, 2026-10-08). A staff seat of the
 * reseller does sign in to its tenant, and that is read from `me`.
 */

const replace = vi.fn();
let pathname = "/";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams(""),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
let me: unknown = null;
let owned: { id: string; slug: string; here: boolean; hasPanel: boolean; live: boolean }[] = [];
vi.mock("@/lib/auth-api", () => ({ authApi: { ownedResellers: async () => ({ resellers: owned }) } }));
vi.mock("../_context/PanelSessionContext", () => ({ usePanelSession: () => ({ me, isLoading: me === null }) }));
vi.mock("../not-found", () => ({ default: () => <p>not-found</p> }));
vi.mock("@/context/LocaleContext", () => ({ useLocale: () => ({ t: (_ns: string, key: string) => key }) }));

const PLATFORM = { userId: "u-staff", tenant: { id: "t-platform", type: "platform_owner", isOwner: true }, permissions: ["tenant.manage"] };
/** The owner on their reseller's domain, after the handoff: the platform's tenant, the door's `here`. */
const ARIAN_OWNER = { userId: "u-ali", tenant: { id: "t-platform", type: "platform_owner", isOwner: false }, permissions: [] };
const OWNS_ARIAN_HERE = [{ id: "r-1", slug: "arian", here: true, hasPanel: true, live: true }];
/** The same owner on the platform's panel: no door, its one live reseller. */
const OWNS_ARIAN = [{ id: "r-old", slug: "old", here: false, hasPanel: false, live: false }, { ...OWNS_ARIAN_HERE[0], here: false }];
const ARIAN_STAFF = { userId: "u-sara", tenant: { id: "r-1", type: "reseller", isOwner: false }, permissions: ["tenant.manage"] };
const ARIAN_CUSTOMER = { userId: "u-cust", tenant: { id: "r-1", type: "reseller", isOwner: false }, permissions: [] };

beforeEach(() => {
  vi.clearAllMocks();
  clearOwnedResellersCache();
  pathname = "/";
  me = null;
  owned = [];
});

describe("the workspace's paths", () => {
  it("carry the id on the platform and none on the reseller's own domain", () => {
    expect(myResellerConsolePath("r-1")).toBe(`${PANEL_MY_RESELLERS}/r-1`);
    expect(myResellerConsolePath("r-1", true)).toBe("/reseller");
    expect(myResellerGatewaysPath("r-1", true)).toBe("/reseller/gateways");
    expect(myResellerUserPath("r-1", "u 1", true)).toBe("/reseller/users/u%201");
    expect(stepHref("domain", "r-1", true)).toBe("/reseller/domains");
  });

  it("map a platform address to its own-domain twin, and nothing else", () => {
    expect(selfWorkspacePath("/my-resellers/r-1", "r-1")).toBe("/reseller");
    expect(selfWorkspacePath("/my-resellers/r-1/users/u-9", "r-1")).toBe("/reseller/users/u-9");
    expect(selfWorkspacePath("/my-resellers/r-10/users", "r-1")).toBeNull();
  });

  it("know whose domain this is: the owner by the door's `here`, a staff seat by its session", () => {
    expect(selfResellerOf(ARIAN_OWNER as never, OWNS_ARIAN_HERE)).toBe("r-1");
    // On the platform's panel too (user, 2026-10-08): its one live reseller, never a terminated one.
    expect(selfResellerOf(ARIAN_OWNER as never, OWNS_ARIAN)).toBe("r-1");
    expect(selfResellerOf(ARIAN_OWNER as never, [OWNS_ARIAN[0]])).toBeNull();
    expect(selfResellerOf(ARIAN_OWNER as never, null)).toBeUndefined();
    expect(selfResellerOf(ARIAN_STAFF as never, [])).toBe("r-1");
    expect(selfResellerOf(ARIAN_CUSTOMER as never, [])).toBeNull();
    expect(selfResellerOf(PLATFORM as never, [])).toBeNull();
  });

  it("know a reseller's domain apart from the platform's, for anyone signed in there", () => {
    expect(resellerDomainOf(ARIAN_OWNER as never, OWNS_ARIAN_HERE)).toBe("r-1");
    expect(resellerDomainOf(ARIAN_OWNER as never, OWNS_ARIAN)).toBeNull();
    expect(resellerDomainOf(ARIAN_CUSTOMER as never, [])).toBe("r-1");
    expect(resellerDomainOf(PLATFORM as never, [])).toBeNull();
  });
});

describe("SelfWorkspace (/reseller)", () => {
  it("draws the screen for the owner on their reseller's domain, and for its staff", async () => {
    me = ARIAN_OWNER;
    owned = OWNS_ARIAN_HERE;
    const { unmount } = render(<SelfWorkspace>{(id) => <p>screen of {id}</p>}</SelfWorkspace>);
    expect(await screen.findByText("screen of r-1")).toBeTruthy();
    unmount();
    me = ARIAN_STAFF;
    render(<SelfWorkspace>{(id) => <p>screen of {id}</p>}</SelfWorkspace>);
    expect(await screen.findByText("screen of r-1")).toBeTruthy();
  });

  it("draws it for the owner on the platform's panel, at the same address", async () => {
    me = ARIAN_OWNER;
    owned = OWNS_ARIAN;
    render(<SelfWorkspace>{(id) => <p>screen of {id}</p>}</SelfWorkspace>);
    expect(await screen.findByText("screen of r-1")).toBeTruthy();
  });

  it("is a 404 for platform staff who own nothing, and for a customer", async () => {
    me = PLATFORM;
    const { unmount } = render(<SelfWorkspace>{(id) => <p>screen of {id}</p>}</SelfWorkspace>);
    expect(await screen.findByText("not-found")).toBeTruthy();
    unmount();
    me = ARIAN_CUSTOMER;
    render(<SelfWorkspace>{(id) => <p>screen of {id}</p>}</SelfWorkspace>);
    expect(await screen.findByText("not-found")).toBeTruthy();
  });
});

describe("PlatformOnlyWorkspace (/my-resellers/:id on a reseller's domain)", () => {
  it("moves the owner's own workspace to the id-less address, keeping the section", async () => {
    me = ARIAN_OWNER;
    owned = OWNS_ARIAN_HERE;
    pathname = "/my-resellers/r-1/gateways";
    render(<PlatformOnlyWorkspace id="r-1"><p>screen</p></PlatformOnlyWorkspace>);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/reseller/gateways"));
    expect(screen.queryByText("screen")).toBeNull();
  });

  it("is a 404 for any other reseller's id", async () => {
    me = ARIAN_OWNER;
    owned = OWNS_ARIAN_HERE;
    pathname = "/my-resellers/r-2";
    render(<PlatformOnlyWorkspace id="r-2"><p>screen</p></PlatformOnlyWorkspace>);
    expect(await screen.findByText("not-found")).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
  });

  it("moves the owner's own workspace on the platform's panel too", async () => {
    me = ARIAN_OWNER;
    owned = OWNS_ARIAN;
    pathname = "/my-resellers/r-1/domains";
    render(<PlatformOnlyWorkspace id="r-1"><p>screen</p></PlatformOnlyWorkspace>);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/reseller/domains"));
  });

  it("leaves platform staff on any reseller by id, and the owner on another of its own", async () => {
    me = PLATFORM;
    pathname = "/my-resellers/r-1";
    const { unmount } = render(<PlatformOnlyWorkspace id="r-1"><p>screen</p></PlatformOnlyWorkspace>);
    expect(await screen.findByText("screen")).toBeTruthy();
    unmount();
    me = ARIAN_OWNER;
    owned = OWNS_ARIAN;
    pathname = "/my-resellers/r-old";
    render(<PlatformOnlyWorkspace id="r-old"><p>screen</p></PlatformOnlyWorkspace>);
    expect(await screen.findByText("screen")).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
  });
});

describe("the menu's users entry", () => {
  const usersHref = (type: "platform_owner" | "reseller", id: string) =>
    visibleMenu(PANEL_MENU, ["tenant.manage"], type, false, false, id)
      .flatMap((e) => (isMenuGroup(e) ? e.children : [e]))
      .find((l) => l.id === "users")?.href;

  it("opens the id-less users page on a reseller's domain, and the id-addressed one on the platform", () => {
    expect(usersHref("reseller", "r-1")).toBe("/reseller/users");
    expect(usersHref("platform_owner", "t-platform")).toBe("/my-resellers/t-platform/users");
  });

  it("still places /reseller/users in the breadcrumb", () => {
    expect(menuTrail(PANEL_MENU, "/reseller/users").at(-1)).toMatchObject({ href: "/reseller/users" });
  });
});
