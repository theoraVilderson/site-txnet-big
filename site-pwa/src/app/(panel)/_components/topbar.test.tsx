import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NotificationsButton } from "./NotificationsButton";
import { WalletButton } from "./WalletButton";
import { notify, PanelToaster } from "./kit";

/**
 * The top bar's two panels on the kit (UX-1-ab, `contract.ux.md` K7).
 *
 * The bar carries `backdrop-filter`, which makes it the containing block for
 * every fixed child and caps its stacking order at `z-20` — the reason the
 * gift modal was portaled. The panels were hand-built `absolute` boxes with
 * their own Esc and outside-press listeners; on the kit's `Popover` they are
 * portaled the same way and share the overlay stack, so Esc closes only the
 * topmost overlay and focus goes back to the control that opened it.
 */

vi.mock("@/context/LocaleContext", () => ({ useLocale: () => ({ t, lang: "en", isRtl: false }) }));
vi.mock("../_hooks/useWalletBalance", () => ({
  useWalletBalance: () => ({ available: "12.00", held: "0", currencyCode: "USD", isLoading: false, failed: false, refresh: vi.fn() }),
}));
const live = vi.hoisted(() => ({ arrived: null as null | { items: Array<{ id: string; title: string; body: string }> } }));
vi.mock("../_hooks/useNotifications", () => ({
  useNotifications: () => ({
    arrived: live.arrived,
    items: [{ id: "n1", type: "admin_message", title: "Hello", body: "A message", createdAt: "2026-10-05T10:00:00.000Z", readAt: null }],
    unreadCount: 1,
    isLoading: false,
    failed: false,
    refresh: vi.fn(),
    markRead: vi.fn(),
    markAllRead: vi.fn(),
  }),
}));

// jsdom has no matchMedia, and react-hot-toast asks it for the OS motion setting.
vi.stubGlobal(
  "matchMedia",
  (query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} }),
);

/** The key back, so an assertion names the string the component asked for. */
const t = (_ns: string, key: string, vars?: Record<string, string | number>) => (vars ? `${key}:${Object.values(vars).join(",")}` : key);

beforeEach(() => {
  document.body.innerHTML = "";
  live.arrived = null;
  notify.dismiss();
});

describe.each([
  { name: "the wallet", Control: WalletButton, open: "wallet.open", panel: "wallet.label" },
  { name: "the notifications bell", Control: NotificationsButton, open: "notifications.open", panel: "notifications.label" },
])("$name", ({ Control, open, panel }) => {
  it("opens a panel portaled out of the bar, named and announced as open", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <header data-testid="bar">
        <Control />
      </header>,
    );
    const trigger = screen.getByRole("button", { name: open });

    await user.click(trigger);

    const dialog = await screen.findByRole("dialog", { name: panel });
    expect(container.contains(dialog)).toBe(false);
    expect(document.body.contains(dialog)).toBe(true);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  it("closes on Escape and gives focus back to its trigger", async () => {
    const user = userEvent.setup();
    render(<Control />);
    const trigger = screen.getByRole("button", { name: open });

    await user.click(trigger);
    await screen.findByRole("dialog", { name: panel });
    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog", { name: panel })).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });
});

describe("a notification that arrives live (F-093-h1)", () => {
  it("is toasted, and the toast opens the bell", async () => {
    live.arrived = { items: [{ id: "n2", title: "Panel down", body: "Your server is being moved" }] };
    const user = userEvent.setup();
    render(
      <>
        <NotificationsButton />
        <PanelToaster />
      </>,
    );

    const toast = await screen.findByRole("button", { name: /Panel down/ });
    expect(toast).toHaveTextContent("Your server is being moved");
    await user.click(toast);

    await screen.findByRole("dialog", { name: "notifications.label" });
  });

  it("is one toast with the count when several land together", async () => {
    live.arrived = {
      items: [
        { id: "n3", title: "One", body: "b" },
        { id: "n2", title: "Two", body: "b" },
      ],
    };
    render(
      <>
        <NotificationsButton />
        <PanelToaster />
      </>,
    );

    await screen.findByRole("button", { name: "notifications.arrived:2" });
    expect(screen.queryByText("One")).not.toBeInTheDocument();
  });
});
