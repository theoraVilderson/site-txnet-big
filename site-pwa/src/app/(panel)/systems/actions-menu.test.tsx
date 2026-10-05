import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLocale } from "@/context/LocaleContext";
import { ActionsMenu } from "./_components/parts";

/**
 * A panel card's rarer actions on the kit (UX-1-ae, `contract.ux.md` K7, R5).
 *
 * The menu was hand-built: it opened and closed, and its items were buttons in
 * a box — Tab reached them, the arrows did nothing, and Esc left focus wherever
 * it was. On the kit `Menu` it is a WAI-ARIA menu button.
 */

vi.mock("@/context/LocaleContext", () => ({ useLocale: vi.fn() }));

beforeEach(() => {
  vi.mocked(useLocale).mockReturnValue({ lang: "en", isRtl: false, t: (_ns: string, key: string) => key } as unknown as ReturnType<typeof useLocale>);
});

function open() {
  const onDrain = vi.fn();
  const onRemove = vi.fn();
  render(
    <ActionsMenu
      label="More for panel-1"
      items={[
        { label: "Drain", onSelect: onDrain },
        { label: "Remove", onSelect: onRemove, tone: "error" },
      ]}
    />,
  );
  const trigger = screen.getByRole("button", { name: "More for panel-1" });
  fireEvent.click(trigger);
  return { trigger, onDrain, onRemove };
}

describe("a panel card's actions menu", () => {
  it("is a named menu the arrows walk", async () => {
    open();
    const menu = await screen.findByRole("menu", { name: "More for panel-1" });
    const items = screen.getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["Drain", "Remove"]);

    await waitFor(() => expect(items[0]).toHaveFocus());
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(items[1]).toHaveFocus();
  });

  it("closes on Esc and gives focus back to its button", async () => {
    const { trigger } = open();
    await screen.findByRole("menu");
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it("runs the picked action once and closes", async () => {
    const { onRemove } = open();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove" }));

    expect(onRemove).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
  });
});
