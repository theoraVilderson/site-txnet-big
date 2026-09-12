import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { LogoutButton } from "./LogoutButton";

/**
 * The logout control, and where it belongs.
 *
 * > **It is a nav action, and the nav is its only home.**
 *
 * That is not a layout preference, it is the decision `AccountSwitcher`'s last
 * row already records: the switcher menu ends with *sign out of all devices*,
 * kept behind its own confirmation, and ordinary logout is deliberately not
 * beside it — the two are different intentions (ADR-0035) and the destructive
 * one must not be a mis-tap away from the everyday one.
 *
 * It also happens to be the only placement that fits. `contract.shell.md`
 * rule 5 budgets the top bar at 360px, where it has 304px of content box; the
 * row wanted ~337px once the wallet joined it, and this was the widest item in
 * it. Two narrower fixes were tried and both failed: collapsing the label
 * returns ~34px against a 33px overflow, and moving it to the drawer only
 * below `sm` left the bar broken from 640px to about 768px, which is every
 * tablet. Taking it out of the bar entirely is what fixes all three widths.
 *
 * jsdom applies no breakpoints, so placement is asserted where it is written —
 * the sidebar footer renders this, `PanelTopBar` no longer imports it. What
 * this file holds is the button's own contract.
 */

vi.mock("@/context/LocaleContext", () => ({ useLocale: vi.fn(() => ({ t, lang: "en" })) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock("@/lib/auth-api", () => ({ authApi: { logout: vi.fn() } }));
vi.mock("../_context/PanelSessionContext", () => ({
  usePanelSession: () => ({ reload: vi.fn() }),
}));

/** The key back, so an assertion names the string the component asked for. */
const t = (_ns: string, key: string) => key;

describe("the logout button", () => {
  it("is announced by its own visible text", () => {
    render(<LogoutButton />);
    // No `aria-label` overriding it: the word is drawn in the expanded nav, so
    // the accessible name and what a sighted user reads are the same string.
    expect(screen.getByRole("button", { name: "logout" })).toBeInTheDocument();
    expect(screen.getByText("logout")).toBeInTheDocument();
  });

  it("keeps its word in the expanded nav", () => {
    render(<LogoutButton />);
    expect(screen.getByText("logout").className).not.toContain("sr-only");
  });

  it("goes icon-only on the collapsed rail without losing its name", () => {
    render(<LogoutButton collapsed />);

    // The word is in the tree twice on a collapsed rail — the label and the
    // hover tooltip beside it — which is exactly why the tooltip is
    // `aria-hidden`: without that, a screen reader would say it twice.
    const both = screen.getAllByText("logout");
    expect(both).toHaveLength(2);

    const label = both.find((el) => el.className.includes("flex-1"));
    // `lg:sr-only`, not `hidden`: the rail collapses only from `lg` up, and the
    // word has to stay readable to a screen reader once it stops being drawn.
    expect(label?.className).toContain("lg:sr-only");
    expect(both.some((el) => el.getAttribute("aria-hidden") !== null)).toBe(true);
    expect(screen.getByRole("button", { name: "logout" })).toBeInTheDocument();
  });
});
