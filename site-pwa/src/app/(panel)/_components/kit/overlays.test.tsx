import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLocale } from "@/context/LocaleContext";
import { ConfirmProvider, useConfirm } from "./confirm";
import { Dialog } from "./Dialog";
import { Menu } from "./Menu";
import { Tabs } from "./Tabs";
import { Tooltip } from "./Tooltip";

/**
 * The kit's overlays (UX-1-d, `contract.ux.md` K7–K9). Fourteen hand-built
 * overlays each got some of this right; what every one now inherits:
 *
 * - focus moves in, Tab cannot leave, and on close it returns to the trigger;
 * - Esc closes the topmost overlay only — a dialog opened over a dialog does
 *   not take its parent with it;
 * - the page behind does not scroll while one is open, and scrolls again after;
 * - a menu is a menu from the keyboard; tabs move with the arrows and can live
 *   in `?tab=`;
 * - `useConfirm` is a promise of a boolean, and a type-to-confirm question
 *   cannot be confirmed until the name is typed.
 */

vi.mock("@/context/LocaleContext", () => ({ useLocale: vi.fn() }));
const replace = vi.fn();
let search = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  usePathname: () => "/settings",
  useSearchParams: () => search,
}));

beforeEach(() => {
  replace.mockReset();
  search = new URLSearchParams();
  vi.mocked(useLocale).mockReturnValue({
    lang: "en",
    t: (_ns: string, key: string, vars?: Record<string, string>) => (vars?.name ? `${key}:${vars.name}` : key),
  } as unknown as ReturnType<typeof useLocale>);
});

function DialogHarness({ nested = false }: { nested?: boolean }) {
  const [open, setOpen] = useState(false);
  const [inner, setInner] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open</button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Edit">
        <input aria-label="Name" />
        <button onClick={() => setInner(true)}>Inner</button>
        {nested && (
          <Dialog open={inner} onClose={() => setInner(false)} title="Sure?">
            <button>Yes</button>
          </Dialog>
        )}
      </Dialog>
    </>
  );
}

describe("Dialog", () => {
  it("takes focus, keeps Tab inside, locks the page, and gives it all back on Esc", async () => {
    render(<DialogHarness />);
    const trigger = screen.getByRole("button", { name: "Open" });
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = await screen.findByRole("dialog", { name: "Edit" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    expect(document.body.style.overflow).toBe("hidden");

    // Tab from the last focusable wraps to the first.
    const focusables = dialog.querySelectorAll<HTMLElement>("button, input");
    focusables[focusables.length - 1].focus();
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(document.activeElement).toBe(focusables[0]);

    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(document.activeElement).toBe(trigger);
    expect(document.body.style.overflow).toBe("");
  });

  it("Esc closes only the topmost of two", async () => {
    render(<DialogHarness nested />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    fireEvent.click(await screen.findByRole("button", { name: "Inner" }));
    await screen.findByRole("dialog", { name: "Sure?" });

    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Sure?" })).not.toBeInTheDocument());
    expect(screen.getByRole("dialog", { name: "Edit" })).toBeInTheDocument();
    expect(document.body.style.overflow).toBe("hidden");
  });
});

describe("Menu", () => {
  it("opens on the trigger, moves with the arrows, runs the item and returns focus", async () => {
    const onRename = vi.fn();
    render(
      <Menu
        label="Actions"
        trigger={<button>More</button>}
        items={[
          { id: "rename", label: "Rename", onSelect: onRename },
          { id: "delete", label: "Delete", tone: "danger", onSelect: () => {} },
        ]}
      />,
    );
    const trigger = screen.getByRole("button", { name: "More" });
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    const menu = await screen.findByRole("menu", { name: "Actions" });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Rename" })));
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Delete" }));
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Rename" }));

    fireEvent.keyDown(menu, { key: "Enter" });
    expect(onRename).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    expect(document.activeElement).toBe(trigger);
  });
});

describe("Tooltip", () => {
  it("describes its trigger while focused", async () => {
    render(
      <Tooltip content="Ctrl+Enter sends">
        <button>Send</button>
      </Tooltip>,
    );
    const button = screen.getByRole("button", { name: "Send" });
    fireEvent.focus(button);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Ctrl+Enter sends");
    expect(button).toHaveAccessibleDescription("Ctrl+Enter sends");
  });
});

describe("Tabs", () => {
  const TABS = [
    { value: "profile", label: "Profile" },
    { value: "appearance", label: "Appearance" },
  ];

  it("selects with the arrows and shows the matching panel", () => {
    function Harness() {
      const [tab, setTab] = useState("profile");
      return (
        <Tabs ariaLabel="Settings" tabs={TABS} value={tab} onChange={setTab}>
          {(active) => <p>panel:{active}</p>}
        </Tabs>
      );
    }
    render(<Harness />);
    const profile = screen.getByRole("tab", { name: "Profile" });
    expect(profile).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(profile, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Appearance" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("panel:appearance");
  });

  it("reads and writes ?tab= when asked, ignoring a value that names no tab", () => {
    search = new URLSearchParams("tab=nope&x=1");
    const { unmount } = render(<Tabs ariaLabel="Settings" tabs={TABS} urlParam="tab">{(a) => a}</Tabs>);
    expect(screen.getByRole("tab", { name: "Profile" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("tab", { name: "Appearance" }));
    expect(replace).toHaveBeenCalledWith("/settings?tab=appearance&x=1", { scroll: false });
    unmount();

    search = new URLSearchParams("tab=appearance");
    render(<Tabs ariaLabel="Settings" tabs={TABS} urlParam="tab">{(a) => a}</Tabs>);
    expect(screen.getByRole("tab", { name: "Appearance" })).toHaveAttribute("aria-selected", "true");
  });
});

describe("useConfirm", () => {
  function Asker({ typeToConfirm, onAnswer }: { typeToConfirm?: string; onAnswer: (v: boolean) => void }) {
    const confirm = useConfirm();
    return (
      <button
        onClick={async () =>
          onAnswer(await confirm({ title: "Delete gateway?", body: "It stops taking payments.", confirmLabel: "Delete", tone: "danger", typeToConfirm }))
        }
      >
        Ask
      </button>
    );
  }

  it("resolves true on confirm and false on cancel", async () => {
    const onAnswer = vi.fn();
    render(
      <ConfirmProvider>
        <Asker onAnswer={onAnswer} />
      </ConfirmProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(onAnswer).toHaveBeenLastCalledWith(true));

    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    fireEvent.click(await screen.findByRole("button", { name: "kit.confirm.cancel" }));
    await waitFor(() => expect(onAnswer).toHaveBeenLastCalledWith(false));
  });

  it("cannot be confirmed until the name is typed", async () => {
    const onAnswer = vi.fn();
    render(
      <ConfirmProvider>
        <Asker typeToConfirm="Zarinpal main" onAnswer={onAnswer} />
      </ConfirmProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    const confirmButton = await screen.findByRole("button", { name: "Delete" });
    expect(confirmButton).toBeDisabled();

    const box = screen.getByLabelText("kit.confirm.typeToConfirm:Zarinpal main");
    fireEvent.change(box, { target: { value: "Zarinpal" } });
    expect(confirmButton).toBeDisabled();
    fireEvent.change(box, { target: { value: "Zarinpal main" } });
    expect(confirmButton).toBeEnabled();
    await act(async () => {
      fireEvent.click(confirmButton);
    });
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith(true));
  });
});
