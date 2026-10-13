import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { useLocale } from "@/context/LocaleContext";
import { guideReadApi } from "@/lib/guide-api";
import { ConnectGuide } from "./_components/ConnectGuide";
import { QrDialog } from "./_components/QrDialog";

/**
 * The QR and the connect guide sit on the kit's overlays (FE-1-m, C-40,
 * `contract.ux.md` K7), not on a backdrop `<div>` of their own:
 *
 * > **Esc closes it and focus goes back to the button that opened it.** A
 * > keyboard or screen-reader user who opened the QR from a row lands on that
 * > row again, not at the top of the page.
 *
 * > **Tab stays inside while it is open.** The page behind is not reachable.
 */

vi.mock("@/context/LocaleContext", () => ({ useLocale: vi.fn() }));
vi.mock("@/lib/guide-api", () => ({ guideReadApi: { forSlot: vi.fn() } }));

beforeEach(() => {
  vi.mocked(useLocale).mockReturnValue({ lang: "en", t: (_ns: string, key: string) => key } as unknown as ReturnType<typeof useLocale>);
  vi.mocked(guideReadApi.forSlot).mockResolvedValue([]);
});

function QrHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Show QR</button>
      <button>Behind</button>
      <QrDialog open={open} title="DE Reality" value="vless://x" label="QR" copied={false} onCopy={() => {}} onClose={() => setOpen(false)} />
    </>
  );
}

describe("QrDialog", () => {
  it("closes on Esc and gives focus back to its trigger", async () => {
    const user = userEvent.setup();
    render(<QrHarness />);
    const trigger = screen.getByRole("button", { name: "Show QR" });
    await user.click(trigger);
    expect(screen.getByRole("dialog")).toContainElement(document.activeElement as HTMLElement);

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it("keeps Tab inside while open", async () => {
    const user = userEvent.setup();
    render(<QrHarness />);
    await user.click(screen.getByRole("button", { name: "Show QR" }));
    for (let i = 0; i < 4; i++) {
      await user.tab();
      expect(screen.getByRole("dialog")).toContainElement(document.activeElement as HTMLElement);
    }
  });
});

describe("ConnectGuide", () => {
  it("opens a kit sheet that closes on Esc and returns focus", async () => {
    const user = userEvent.setup();
    render(<ConnectGuide />);
    const trigger = screen.getByRole("button", { name: "guideHelp.connect.open" });
    await user.click(trigger);
    const sheet = await screen.findByRole("dialog", { name: "guideHelp.connect.title" });
    expect(sheet).toContainElement(document.activeElement as HTMLElement);

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });
});
