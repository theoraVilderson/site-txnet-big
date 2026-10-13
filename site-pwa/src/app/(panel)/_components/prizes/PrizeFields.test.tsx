import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { PrizeFields, type PrizeCore, type PrizeKeys } from "./PrizeFields";

/**
 * The prize fields the wheel and the lottery editors share (CS-1-i, C-27):
 * one home for which type carries a figure, what a type with none writes, and
 * the coupon picker's three states.
 */

vi.mock("@/context/LocaleContext", () => ({ useLocale: () => ({ t: (_ns: string, key: string) => key, lang: "en" }) }));
vi.mock("../kit/Select", () => ({
  Select: ({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) => (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  ),
}));
vi.mock("../../coupons/_components/VariantPicker", () => ({ VariantPicker: ({ id }: { id: string }) => <div data-testid={id} /> }));

const KEYS: PrizeKeys = {
  label: "label", type: "type", moveUp: "moveUp", moveDown: "moveDown", remove: "remove", valueGb: "valueGb",
  valueDays: "valueDays", valuePercent: "valuePercent", template: "template", templateId: "templateId",
  templatesLoading: "templatesLoading", noTemplates: "noTemplates", validDays: "validDays", variant: "variant",
};
type Type = "bonus_traffic_gb" | "discount_coupon" | "free_grant" | "empty";
const TYPES: readonly Type[] = ["bonus_traffic_gb", "discount_coupon", "free_grant", "empty"];
const TYPE_KEYS: Record<Type, string> = { bonus_traffic_gb: "gb", discount_coupon: "coupon", free_grant: "grant", empty: "empty" };

const prize = (prizeType: Type): PrizeCore<Type> => ({
  label: "P", prizeType, prizeValue: "5", couponTemplateId: "", couponValidDays: "7", variantId: "",
});

function renderFields(p: PrizeCore<Type>, templates: Parameters<typeof PrizeFields>[0]["templates"] = []) {
  const onPatch = vi.fn();
  render(
    <PrizeFields prize={p} errors={{}} keys={KEYS} types={TYPES} typeKeys={TYPE_KEYS} templates={templates}
      variantFieldId="v-0" ownerTenant="t-1" onPatch={onPatch} />,
  );
  return onPatch;
}

describe("PrizeFields", () => {
  it("asks for a figure only for a type that carries one", () => {
    renderFields(prize("bonus_traffic_gb"));
    expect(screen.getByText("valueGb")).toBeTruthy();
  });

  it("writes 0 for the figure of a type that carries none, and asks for the variant a free grant gives", () => {
    const onPatch = renderFields(prize("free_grant"));
    expect(screen.queryByText("valueGb")).toBeNull();
    expect(screen.getByTestId("v-0")).toBeTruthy();
    fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "empty" } });
    expect(onPatch).toHaveBeenCalledWith({ prizeType: "empty", prizeValue: "0" });
  });

  it("keeps the figure when the new type carries one", () => {
    const onPatch = renderFields(prize("free_grant"));
    fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "bonus_traffic_gb" } });
    expect(onPatch).toHaveBeenCalledWith({ prizeType: "bonus_traffic_gb" });
  });

  it("lets the coupon id be typed when the coupons cannot be read", () => {
    const onPatch = renderFields(prize("discount_coupon"), "failed");
    fireEvent.change(screen.getByPlaceholderText("templateId"), { target: { value: "c-9" } });
    expect(onPatch).toHaveBeenCalledWith({ couponTemplateId: "c-9" });
  });

  it("says the coupons are loading", () => {
    renderFields(prize("discount_coupon"), null);
    expect(screen.getByText("templatesLoading")).toBeTruthy();
  });

  it("says the tenant has no coupon to copy", () => {
    renderFields(prize("discount_coupon"), []);
    expect(screen.getByText("noTemplates")).toBeTruthy();
  });
});
