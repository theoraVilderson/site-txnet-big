/**
 * The shop's three steps (UX-1-aa, contract.ux.md U1): choose, invoice and
 * pay, delivered — read from the page's own `phase`, never kept beside it.
 *
 * What breaks without anyone seeing it: a step indicator that disagrees with
 * the screen under it (a return to an invoice landing on "choose"), or one a
 * screen reader cannot place itself in.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { useLocale } from "@/context/LocaleContext";
import { ShopSteps } from "./_components/ShopSteps";
import { SHOP_STEPS, shopStep } from "./_lib/shop";

vi.mock("@/context/LocaleContext", () => ({ useLocale: vi.fn() }));
vi.mocked(useLocale).mockReturnValue({ t: (_ns: string, key: string) => key, isRtl: false } as never);

describe("shop steps (U1)", () => {
  it("each phase is one step, in the order they are walked", () => {
    expect(SHOP_STEPS).toEqual(["choose", "pay", "delivered"]);
    expect(shopStep("list")).toBe(0);
    expect(shopStep("checkout")).toBe(1);
    expect(shopStep("paid")).toBe(2);
  });

  it("names the current step for a screen reader and marks the ones behind it done", () => {
    render(<ShopSteps current={1} />);
    const items = within(screen.getByRole("list", { name: "shop.steps.label" })).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    ["shop.steps.choose", "shop.steps.pay", "shop.steps.delivered"].forEach((label, i) => expect(items[i]).toHaveTextContent(label));
    expect(items[1]).toHaveAttribute("aria-current", "step");
    expect(items[0]).toHaveAttribute("data-state", "done");
    expect(items[2]).toHaveAttribute("data-state", "todo");
  });
});
