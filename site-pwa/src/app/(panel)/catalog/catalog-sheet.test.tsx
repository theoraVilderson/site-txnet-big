import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLocale } from "@/context/LocaleContext";
import { Select } from "../_components/kit/Select";
import { Sheet } from "./_components/catalog-ui";

/**
 * A catalog sheet on the kit (UX-1-ac, `contract.ux.md` K7, R1).
 *
 * The sheet was a portal with its own `keydown` listener on `document`, so an
 * Esc pressed to close a select's list inside it closed the whole sheet — and
 * a half-filled form with it. On the kit's `Dialog` it is one layer on the
 * overlay stack: the list's Esc is the list's, and the sheet closes on the next.
 * The systems, coupons, user-groups and reseller sheets share this frame.
 */

vi.mock("@/context/LocaleContext", () => ({ useLocale: vi.fn() }));
vi.mock("./_lib/surface", () => ({ useCatalogSurface: () => ({}) }));

beforeEach(() => {
  vi.mocked(useLocale).mockReturnValue({ lang: "en", isRtl: false, t: (_ns: string, key: string) => key } as unknown as ReturnType<typeof useLocale>);
});

function Harness({ onClose }: { onClose: () => void }) {
  const [value, setValue] = useState("a");
  return (
    <Sheet title="New category" onClose={onClose}>
      <Select
        ariaLabel="Parent"
        value={value}
        onChange={setValue}
        options={[
          { value: "a", label: "Alpha" },
          { value: "b", label: "Beta" },
        ]}
      />
    </Sheet>
  );
}

describe("a catalog sheet", () => {
  it("is a named modal dialog", () => {
    render(<Harness onClose={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: "New category" })).toHaveAttribute("aria-modal", "true");
  });

  it("lets Esc close a select's list first, and itself only on the next Esc", async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "Parent: Alpha" }));
    const list = await screen.findByRole("listbox");
    fireEvent.keyDown(list, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
