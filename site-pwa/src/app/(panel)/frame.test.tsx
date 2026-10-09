import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { PANEL_COUPONS, PANEL_DEPOSIT, PANEL_HOME, PANEL_RESELLERS } from "@/lib/routes";
import { copyText } from "./_lib/clipboard";
import { PANEL_MENU, menuTrail } from "./_lib/panel-menu";
import { PageHeader } from "./_components/kit/PageHeader";
import PanelError from "./error";
import PanelNotFound from "./not-found";

/**
 * The panel's frame (UX-1-i, `contract.ux.md` K14, N9):
 *
 * - the breadcrumb trail is the menu tree — the group, then the page — and the
 *   page's own tail label after it; a page alone at the top has no trail to show;
 * - below `md` the trail is a back link to the nearest crumb that is a page;
 * - a render crash shows a card that retries, goes home, and hands support the
 *   digest with a copy button — never Next's raw error;
 * - an unknown page offers the dashboard.
 */

vi.mock("@/context/LocaleContext", () => ({ useLocale: vi.fn() }));
let pathname = "/";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));
vi.mock("./_lib/clipboard", () => ({ copyText: vi.fn(async () => true) }));

const M = FrontendI18nKeys.common.shell.menu;
const SEC = FrontendI18nKeys.common.shell.sections;

beforeEach(() => {
  pathname = "/";
  vi.mocked(useLocale).mockReturnValue({
    lang: "en",
    isRtl: false,
    t: (_ns: string, key: string, vars?: Record<string, string>) => (vars?.page ? `${key}:${vars.page}` : key),
  } as unknown as ReturnType<typeof useLocale>);
});

describe("menuTrail", () => {
  it("is the section, the group and then the page, neither heading a link", () => {
    expect(menuTrail(PANEL_MENU, PANEL_DEPOSIT)).toEqual([
      { label: SEC.account, href: null, section: true },
      { label: M.wallet, href: null },
      { label: M.deposit, href: PANEL_DEPOSIT },
    ]);
    expect(menuTrail(PANEL_MENU, PANEL_COUPONS)).toEqual([
      { label: SEC.sales, href: null, section: true },
      { label: M.coupons, href: PANEL_COUPONS },
    ]);
  });

  it("finds the page a deeper path belongs to", () => {
    expect(menuTrail(PANEL_MENU, `${PANEL_RESELLERS}/r-1`)).toEqual([
      { label: SEC.people, href: null, section: true },
      { label: M.resellers, href: null },
      { label: M.resellerList, href: PANEL_RESELLERS },
    ]);
  });

  it("matches a tenant's own page on the tenant the path names", () => {
    expect(menuTrail(PANEL_MENU, "/my-resellers/t-9/team/s-1")).toEqual([
      { label: SEC.people, href: null, section: true },
      { label: M.team, href: "/my-resellers/t-9/team" },
    ]);
    expect(menuTrail(PANEL_MENU, "/my-resellers/t-9/teamx")).toEqual([]);
  });

  it("is empty on a path no menu entry owns", () => {
    expect(menuTrail(PANEL_MENU, "/nowhere")).toEqual([]);
  });
});

describe("PageHeader", () => {
  it("draws the trail above the title, the page itself current", () => {
    pathname = PANEL_DEPOSIT;
    render(<PageHeader title="Top up" subtitle="Add to the wallet" actions={<button>New</button>} />);
    const nav = screen.getByRole("navigation", { name: "kit.pageHeader.breadcrumb" });
    const items = within(nav).getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toEqual([SEC.account, M.wallet, M.deposit]);
    expect(within(nav).getByText(M.deposit)).toHaveAttribute("aria-current", "page");
    expect(within(nav).queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Top up" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New" })).toBeInTheDocument();
  });

  it("adds the tail, makes the page a link, and goes back to it below md", () => {
    pathname = `${PANEL_RESELLERS}/r-1`;
    render(<PageHeader title="acme" tail="acme" />);
    const nav = screen.getByRole("navigation", { name: "kit.pageHeader.breadcrumb" });
    expect(within(nav).getByRole("link", { name: M.resellerList })).toHaveAttribute("href", PANEL_RESELLERS);
    expect(within(nav).getByText("acme")).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: `kit.pageHeader.back:${M.resellerList}` })).toHaveAttribute("href", PANEL_RESELLERS);
  });

  it("shows no trail for a page alone in its section — the section's name is not a trail", () => {
    pathname = "/shop";
    render(<PageHeader title="Shop" />);
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    pathname = PANEL_COUPONS;
    render(<PageHeader title="Coupons" />);
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  });
});

describe("the error card", () => {
  it("retries, goes home, and copies the digest for support", async () => {
    const reset = vi.fn();
    render(<PanelError error={Object.assign(new Error("boom"), { digest: "d-42" })} reset={reset} />);
    expect(screen.queryByText("boom")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "shell.error.retry" }));
    expect(reset).toHaveBeenCalledOnce();
    expect(screen.getByRole("link", { name: "shell.error.home" })).toHaveAttribute("href", PANEL_HOME);
    expect(screen.getByText("d-42")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "shell.error.copy" }));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith("d-42"));
  });

  it("has no digest row when Next gave none", () => {
    render(<PanelError error={new Error("boom")} reset={() => {}} />);
    expect(screen.queryByRole("button", { name: "shell.error.copy" })).not.toBeInTheDocument();
  });
});

describe("not found", () => {
  it("offers the dashboard", () => {
    render(<PanelNotFound />);
    expect(screen.getByRole("link", { name: "shell.notFound.home" })).toHaveAttribute("href", PANEL_HOME);
  });
});
