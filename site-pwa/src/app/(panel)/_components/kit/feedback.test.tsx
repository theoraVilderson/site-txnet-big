import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import toast, { useToasterStore } from "react-hot-toast";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLocale } from "@/context/LocaleContext";
import { ConfirmProvider } from "./confirm";
import { notify, PanelToaster, TOAST_LIMIT } from "./notify";
import { SaveBar } from "./SaveBar";

/**
 * Feedback (UX-1-e, `contract.ux.md` K10–K11).
 *
 * - A toast reports an action and leaves: an error is announced at once
 *   (`role="alert"`, assertive), everything else politely, and no more than
 *   three are on screen — a burst of failures must not bury the page.
 * - A dirty form shows the save bar; Save turns into "Saved" as a toast, never
 *   a line that stays; a failed save is the form's to report inline, so the
 *   bar adds no toast of its own and stays up.
 * - Leaving a dirty page asks first — an in-app link and a reload alike — and
 *   a "no" keeps the person exactly where they were.
 */

vi.mock("@/context/LocaleContext", () => ({ useLocale: vi.fn() }));
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

// jsdom has no matchMedia, and react-hot-toast asks it for the OS motion setting.
vi.stubGlobal(
  "matchMedia",
  (query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} }),
);

beforeEach(() => {
  push.mockReset();
  vi.mocked(useLocale).mockReturnValue({ lang: "en", isRtl: false, t: (_ns: string, key: string) => key } as unknown as ReturnType<typeof useLocale>);
});

afterEach(() => {
  act(() => toast.remove());
});

describe("notify", () => {
  it("announces an error assertively and the rest politely", async () => {
    render(<PanelToaster />);
    act(() => {
      notify.success("Copied");
      notify.error("Could not delete");
    });
    const error = await screen.findByText("Could not delete");
    expect(error.closest("[role]")).toHaveAttribute("role", "alert");
    expect(error.closest("[aria-live]")).toHaveAttribute("aria-live", "assertive");
    const ok = screen.getByText("Copied");
    expect(ok.closest("[role]")).toHaveAttribute("role", "status");
    expect(ok.closest("[aria-live]")).toHaveAttribute("aria-live", "polite");
  });

  it(`keeps at most ${TOAST_LIMIT} on screen, dropping the oldest`, async () => {
    let visible: string[] = [];
    function Probe() {
      visible = useToasterStore()
        .toasts.filter((t) => t.visible)
        .map((t) => String(t.message));
      return null;
    }
    render(
      <>
        <PanelToaster />
        <Probe />
      </>,
    );
    act(() => {
      for (const n of [1, 2, 3, 4, 5]) notify.info(`note ${n}`);
    });
    await waitFor(() => expect(visible.sort()).toEqual(["note 3", "note 4", "note 5"]));
  });
});

function Form({ onSave }: { onSave: () => Promise<unknown> }) {
  const [name, setName] = useState("Main");
  const [saved, setSaved] = useState("Main");
  return (
    <ConfirmProvider>
      <PanelToaster />
      <a href="/wallet">Wallet</a>
      <input aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} />
      <SaveBar
        dirty={name !== saved}
        onSave={async () => {
          await onSave();
          setSaved(name);
        }}
        onDiscard={() => setName(saved)}
      />
    </ConfirmProvider>
  );
}

describe("SaveBar", () => {
  it("appears when dirty, saves, and says so in a toast", async () => {
    let finish!: () => void;
    const onSave = vi.fn(() => new Promise<void>((r) => (finish = r)));
    render(<Form onSave={onSave} />);
    expect(screen.queryByRole("button", { name: "kit.saveBar.save" })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Backup" } });
    const save = await screen.findByRole("button", { name: "kit.saveBar.save" });
    fireEvent.click(save);
    expect(save).toHaveAttribute("aria-busy", "true");

    await act(async () => finish());
    expect(await screen.findByText("kit.saveBar.saved")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("button", { name: "kit.saveBar.save" })).not.toBeInTheDocument());
  });

  it("a failed save adds no toast and keeps the bar", async () => {
    render(<Form onSave={() => Promise.reject(new Error("409"))} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Backup" } });
    const save = await screen.findByRole("button", { name: "kit.saveBar.save" });
    await act(async () => fireEvent.click(save));
    await waitFor(() => expect(save).not.toHaveAttribute("aria-busy"));
    expect(screen.queryByText("kit.saveBar.saved")).not.toBeInTheDocument();
    expect(save).toBeInTheDocument();
  });

  it("Discard puts the form back", async () => {
    render(<Form onSave={() => Promise.resolve()} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Backup" } });
    fireEvent.click(await screen.findByRole("button", { name: "kit.saveBar.discard" }));
    expect(screen.getByLabelText("Name")).toHaveValue("Main");
  });
});

describe("leaving a dirty page", () => {
  it("asks before an in-app link, and stays on no", async () => {
    render(<Form onSave={() => Promise.resolve()} />);

    // Clean: the link is left alone.
    const clean = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    screen.getByRole("link", { name: "Wallet" }).dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Backup" } });
    await screen.findByRole("button", { name: "kit.saveBar.save" });

    fireEvent.click(screen.getByRole("link", { name: "Wallet" }));
    await screen.findByRole("dialog", { name: "kit.unsaved.title" });
    fireEvent.click(screen.getByRole("button", { name: "kit.confirm.cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(push).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("link", { name: "Wallet" }));
    fireEvent.click(await screen.findByRole("button", { name: "kit.unsaved.leave" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/wallet"));
  });

  it("holds a reload or a closed tab with beforeunload", async () => {
    render(<Form onSave={() => Promise.resolve()} />);
    const before = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(before);
    expect(before.defaultPrevented).toBe(false);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Backup" } });
    await screen.findByRole("button", { name: "kit.saveBar.save" });
    const dirty = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
  });
});
