import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Home, Wallet } from "lucide-react";
import {
  PANEL_MENU,
  activeHref,
  visibleMenu,
  type PanelMenuEntry,
} from "./panel-menu";

/**
 * The sidebar's menu (F-093-a). Both things asserted here fail with nothing
 * red anywhere:
 *
 * - **A menu entry with no page yet is hidden, not a dead link.** The menu
 *   declares every legacy entry so a page row only has to give it an `href`;
 *   one given too early is a 404 a user clicks into. The first case reads the
 *   route tree itself, so it goes red the day an `href` outruns its page.
 * - **Exactly one entry is highlighted.** `/` is a prefix of every path, and
 *   a sibling (`/financial/deposit`) is nested under its group's own page
 *   (`/financial`) — so "starts with" lights up two entries and "equals" lights
 *   up none on any detail page. The legacy panel compared exact paths and wrote
 *   one href with a trailing slash, so that entry was never active at all.
 */

const PANEL_ROUTES = join(__dirname, "..");

const link = (id: string, href: string | null): PanelMenuEntry => ({
  id,
  label: id,
  icon: Home,
  href,
});

/**
 * No entry in `PANEL_MENU` is permission-gated yet, so the cases above pass any
 * list. Named rather than `[]` so it stays obvious that those two assertions are
 * about pages and highlighting, not about authority.
 */
const HOLDS_EVERYTHING = ["settlement.manage", "worker.manage"];

describe("PANEL_MENU", () => {
  it("links only to pages that exist under the (panel) route group", () => {
    const hrefs = visibleMenu(PANEL_MENU, HOLDS_EVERYTHING).flatMap((entry) =>
      "children" in entry ? entry.children.map((c) => c.href) : [entry.href],
    );

    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      expect(
        existsSync(join(PANEL_ROUTES, href, "page.tsx")),
        `${href} is in the menu but has no page.tsx`,
      ).toBe(true);
    }
  });
});

describe("visibleMenu", () => {
  it("drops links with no page and groups left with no child, keeping order", () => {
    const menu: PanelMenuEntry[] = [
      link("home", "/"),
      link("buy", null),
      {
        id: "financial",
        label: "financial",
        icon: Wallet,
        children: [
          { id: "history", label: "history", icon: Home, href: null },
          { id: "deposit", label: "deposit", icon: Home, href: null },
        ],
      },
      {
        id: "accounts",
        label: "accounts",
        icon: Wallet,
        children: [
          { id: "list", label: "list", icon: Home, href: null },
          { id: "add", label: "add", icon: Home, href: "/accounts/add" },
        ],
      },
      link("support", "/support"),
    ];

    const visible = visibleMenu(menu, HOLDS_EVERYTHING);

    expect(visible.map((e) => e.id)).toEqual(["home", "accounts", "support"]);
    const accounts = visible[1];
    expect("children" in accounts && accounts.children.map((c) => c.id)).toEqual(
      ["add"],
    );
  });

  /**
   * The permission gate (F-097). This is the half of "no `admin` in the URL"
   * that the browser can see: authority comes off the caller, so an entry the
   * caller holds no permission for is never rendered — and, because the same
   * `permissions[]` is what `forward-auth` enforces, hiding it hides exactly
   * what the edge would have refused.
   *
   * Every case below passes an existing page, so a failure can only be the
   * gate. `held` is what `GET /auth/me` answered; **an empty list gates
   * everything gated**, which is the safe direction — a caller whose `me` call
   * failed sees the ungated panel, not an operator's.
   */
  it("hides an entry whose permissions the caller does not hold", () => {
    const menu: PanelMenuEntry[] = [
      link("home", "/"),
      { id: "settle", label: "settle", icon: Home, href: "/settle", requires: ["settlement.manage"] },
    ];

    expect(visibleMenu(menu, []).map((e) => e.id)).toEqual(["home"]);
    expect(visibleMenu(menu, ["worker.manage"]).map((e) => e.id)).toEqual(["home"]);
    expect(visibleMenu(menu, ["settlement.manage"]).map((e) => e.id)).toEqual([
      "home",
      "settle",
    ]);
  });

  it("needs every permission an entry names, the way PermissionsGuard does", () => {
    const menu: PanelMenuEntry[] = [
      { id: "both", label: "both", icon: Home, href: "/both", requires: ["a", "b"] },
    ];

    expect(visibleMenu(menu, ["a"]).map((e) => e.id)).toEqual([]);
    expect(visibleMenu(menu, ["a", "b"]).map((e) => e.id)).toEqual(["both"]);
  });

  it('shows every entry to a holder of "*", and treats no other pattern as a wildcard (F-101-d)', () => {
    const menu: PanelMenuEntry[] = [
      { id: "both", label: "both", icon: Home, href: "/both", requires: ["a.x", "b.y"] },
    ];

    expect(visibleMenu(menu, ["*"]).map((e) => e.id)).toEqual(["both"]);
    expect(visibleMenu(menu, ["a.*", "b.*"]).map((e) => e.id)).toEqual([]);
  });

  it("drops a group left with no permitted child, and gates a whole group by its own requirement", () => {
    const operatorOnly: PanelMenuEntry = {
      id: "operations",
      label: "operations",
      icon: Wallet,
      requires: ["worker.manage"],
      children: [{ id: "workers", label: "workers", icon: Home, href: "/workers" }],
    };
    const mixed: PanelMenuEntry = {
      id: "financial",
      label: "financial",
      icon: Wallet,
      children: [
        { id: "history", label: "history", icon: Home, href: "/financial" },
        { id: "settle", label: "settle", icon: Home, href: "/settle", requires: ["settlement.manage"] },
      ],
    };

    const plain = visibleMenu([operatorOnly, mixed], []);
    expect(plain.map((e) => e.id)).toEqual(["financial"]);
    expect("children" in plain[0] && plain[0].children.map((c) => c.id)).toEqual(
      ["history"],
    );

    const operator = visibleMenu([operatorOnly, mixed], [
      "worker.manage",
      "settlement.manage",
    ]);
    expect(operator.map((e) => e.id)).toEqual(["operations", "financial"]);
  });
});

describe("visibleMenu, by tenant type", () => {
  // F-019-d. `tenant_billing.topup` is granted to `Admin` in every tenant, the
  // platform owner's too — which has no billing wallet, so the permission alone
  // would show it a page that can only answer 403.
  const billing: PanelMenuEntry = {
    id: "billing",
    label: "billing",
    icon: Wallet,
    href: "/financial/billing",
    requires: ["tenant_billing.topup"],
    tenantTypes: ["reseller"],
  };
  const held = ["tenant_billing.topup"];

  it("shows an entry only inside a tenant type it names", () => {
    expect(visibleMenu([billing], held, "reseller").map((e) => e.id)).toEqual(["billing"]);
    expect(visibleMenu([billing], held, "platform_owner")).toEqual([]);
    expect(visibleMenu([billing], ["*"], "platform_owner")).toEqual([]);
  });

  it("hides it while the tenant type is unknown, and still needs the permission", () => {
    expect(visibleMenu([billing], held, null)).toEqual([]);
    expect(visibleMenu([billing], [], "reseller")).toEqual([]);
  });

  it("is in PANEL_MENU for a reseller holding the permission, and not for the platform owner", () => {
    const hrefs = (type: "reseller" | "platform_owner") =>
      visibleMenu(PANEL_MENU, held, type).flatMap((e) =>
        "children" in e ? e.children.map((c) => c.href) : [e.href],
      );
    expect(hrefs("reseller")).toContain("/financial/billing");
    expect(hrefs("platform_owner")).not.toContain("/financial/billing");
  });
});

describe("activeHref", () => {
  const hrefs = ["/", "/financial", "/financial/deposit", "/accounts/add"];

  it.each([
    ["/", "/"],
    ["/accounts/add", "/accounts/add"],
    ["/financial", "/financial"],
    ["/financial/", "/financial"],
    ["/financial/deposit", "/financial/deposit"],
    ["/financial/deposit/", "/financial/deposit"],
    ["/financial/42", "/financial"],
    ["/financial/deposits", "/financial"],
    ["/settings", "/"],
  ])("%s highlights %s", (pathname, expected) => {
    expect(activeHref(hrefs, pathname)).toBe(expected);
  });

  it("highlights nothing when not even the home entry is visible", () => {
    expect(activeHref(["/financial"], "/settings")).toBeNull();
  });
});
