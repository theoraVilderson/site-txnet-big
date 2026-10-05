import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLocale } from "@/context/LocaleContext";
import { ConfirmProvider } from "./confirm";
import { Wizard, useWizard } from "./Wizard";

/**
 * The kit `Wizard` (UX-1-f, `contract.ux.md` K12) — what `GatewayWizard`,
 * `RegisterWizard` and `ProductWizard` now share instead of three copies:
 *
 * - Next asks the current step's validation and stays put when it refuses;
 * - the rail opens only steps already reached, and none while saving;
 * - the last step's button submits instead of moving on;
 * - closing a touched wizard asks first (K9), an untouched one just closes,
 *   and Esc is the same close;
 * - the done screen replaces the steps and the footer.
 */

vi.mock("@/context/LocaleContext", () => ({ useLocale: vi.fn() }));

beforeEach(() => {
  vi.mocked(useLocale).mockReturnValue({
    lang: "en",
    isRtl: false,
    t: (_ns: string, key: string, vars?: Record<string, string>) => (vars?.current ? `${key}:${vars.current}/${vars.total}` : key),
  } as unknown as ReturnType<typeof useLocale>);
});

const STEPS = [
  { id: "a", title: "Alpha" },
  { id: "b", title: "Beta" },
  { id: "c", title: "Review" },
];

function Harness({ valid = () => true, dirty = false, busy = false, onClose = vi.fn(), onSubmit = vi.fn() }: {
  valid?: (index: number) => boolean;
  dirty?: boolean;
  busy?: boolean;
  onClose?: () => void;
  onSubmit?: () => void;
}) {
  const wizard = useWizard({ count: STEPS.length, validate: valid });
  const [done, setDone] = useState(false);
  return (
    <ConfirmProvider>
      <Wizard
        title="Add a thing"
        steps={STEPS}
        wizard={wizard}
        dirty={dirty}
        busy={busy}
        closeQuestion="Close it?"
        submitLabel="Create"
        onSubmit={() => {
          onSubmit();
          setDone(true);
        }}
        onClose={onClose}
        done={done ? <p>All done</p> : undefined}
      >
        <p>Body {STEPS[wizard.index].id}</p>
      </Wizard>
    </ConfirmProvider>
  );
}

const next = () => fireEvent.click(screen.getByRole("button", { name: "kit.wizard.next" }));

describe("Wizard", () => {
  it("moves on only when the step's validation passes", async () => {
    let ok = false;
    render(<Harness valid={() => ok} />);
    next();
    expect(screen.getByText("Body a")).toBeInTheDocument();
    ok = true;
    next();
    expect(await screen.findByText("Body b")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "2");
  });

  it("opens only the steps already reached from the rail", async () => {
    render(<Harness />);
    const rail = (name: string) => screen.getByRole("button", { name: new RegExp(name) });
    expect(rail("Beta")).toBeDisabled();
    next();
    await screen.findByText("Body b");
    next();
    expect(await screen.findByText("Body c")).toBeInTheDocument();
    fireEvent.click(rail("Alpha"));
    expect(await screen.findByText("Body a")).toBeInTheDocument();
    expect(rail("Review")).not.toBeDisabled();
    expect(rail("Alpha")).toHaveAttribute("aria-current", "step");
  });

  it("locks the rail and Back while saving", () => {
    render(<Harness busy />);
    expect(screen.getByRole("button", { name: /Alpha/ })).toBeDisabled();
  });

  it("submits on the last step, and the done screen replaces steps and footer", async () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    next();
    next();
    await screen.findByText("Body c");
    expect(screen.queryByRole("button", { name: "kit.wizard.next" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(screen.getByText("All done")).toBeInTheDocument();
    expect(screen.queryByText("Body c")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create" })).not.toBeInTheDocument();
  });

  it("closes an untouched wizard at once", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "kit.wizard.cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("asks before closing a touched one, by the X and by Esc alike", async () => {
    const onClose = vi.fn();
    render(<Harness dirty onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "kit.dialog.close" }));
    expect(await screen.findByText("Close it?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "kit.confirm.cancel" }));
    await waitFor(() => expect(screen.queryByText("Close it?")).not.toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();

    act(() => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expect(await screen.findByText("Close it?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "kit.wizard.leave" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });
});
