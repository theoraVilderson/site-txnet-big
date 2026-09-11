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

describe("PANEL_MENU", () => {
  it("links only to pages that exist under the (panel) route group", () => {
    const hrefs = visibleMenu(PANEL_MENU).flatMap((entry) =>
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

    const visible = visibleMenu(menu);

    expect(visible.map((e) => e.id)).toEqual(["home", "accounts", "support"]);
    const accounts = visible[1];
    expect("children" in accounts && accounts.children.map((c) => c.id)).toEqual(
      ["add"],
    );
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
