import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLocale } from "@/context/LocaleContext";
import { ConfirmProvider } from "../_components/kit/confirm";
import { COUPON_KEYS, emptyCouponForm, validateCouponForm, type CouponForm } from "./_lib/coupon-form";
import { COUPON_STEPS, HOURS_FROM, HOURS_TO, STEP_FIELDS, firstStepWithError, refusalStep, setFields, stepErrors } from "./_lib/coupon-steps";
import { CouponWizard } from "./_components/CouponWizard";

/**
 * A new coupon as a kit `Wizard` (UX-3-b, `contract.coupons.md` rule 15):
 * code and type → limits → schedule → audience → where → review. The rules
 * stay `validateCouponForm`'s; a step only shows, and stops on, its own
 * fields' errors, and the review lists only what was set.
 */

vi.mock("@/context/LocaleContext", () => ({ useLocale: vi.fn() }));
vi.mock("../_components/kit/DatePicker", () => ({ DatePicker: () => null }));
vi.mock("@/hooks/useApiError", () => ({ useApiErrorMessage: () => () => "failed" }));
vi.mock("@/lib/billing-api", async (original) => ({ ...(await original<object>()), billingApi: { adminGateways: vi.fn().mockResolvedValue([]), createCoupon: vi.fn() } }));

const F = COUPON_KEYS.form;

beforeEach(() => {
  vi.mocked(useLocale).mockReturnValue({ lang: "en", isRtl: false, t: (_ns: string, key: string) => key } as unknown as ReturnType<typeof useLocale>);
});

const form = (patch: Partial<CouponForm> = {}): CouponForm => ({ ...emptyCouponForm(), ...patch });

describe("the coupon steps", () => {
  it("put every field of the form on exactly one step before review", () => {
    const placed = Object.values(STEP_FIELDS).flat();
    expect([...placed].sort()).toEqual(Object.keys(emptyCouponForm()).sort());
    expect(new Set(placed).size).toBe(placed.length);
    expect(COUPON_STEPS.at(-1)).toBe("review");
  });

  it("stop a step only on its own errors", () => {
    const all = validateCouponForm(form({ activeHourFrom: "22" }), null, null);
    expect(Object.keys(stepErrors("basics", all)).sort()).toEqual(["code", "discountValue"]);
    expect(Object.keys(stepErrors("limits", all))).toEqual([]);
    expect(Object.keys(stepErrors("schedule", all))).toEqual(["activeHourTo"]);
    expect(firstStepWithError(validateCouponForm(form({ code: "SPRING", discountValue: "10", activeHourFrom: "22" }), null, null))).toBe("schedule");
  });

  it("send a refusal back to the step that holds its field", () => {
    expect(refusalStep("code_taken")).toBe("basics");
    expect(refusalStep("targeted_needs_users")).toBe("audience");
    expect(refusalStep("gateway_not_found")).toBe("where");
    expect(refusalStep("not_platform_owner")).toBeNull();
  });

  it("list on review only what was set", () => {
    expect(setFields(form(), "limits")).toEqual([]);
    expect(setFields(form({ totalUsageLimit: "50" }), "limits")).toEqual(["totalUsageLimit"]);
    expect(setFields(form({ isActive: false }), "basics")).toContain("isActive");
  });

  it("offer the hour window as whole hours, the end one past the start's last", () => {
    expect(HOURS_FROM).toEqual(Array.from({ length: 24 }, (_, h) => h));
    expect(HOURS_TO).toEqual(Array.from({ length: 24 }, (_, h) => h + 1));
  });
});

describe("CouponWizard", () => {
  const open = () =>
    render(
      <ConfirmProvider>
        <CouponWizard me={null} onClose={vi.fn()} onSaved={vi.fn()} />
      </ConfirmProvider>,
    );

  it("keeps Next on code and type until they are right, then moves to limits", async () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: /kit\.wizard\.next/ }));
    expect(screen.getAllByRole("alert").map((a) => a.textContent)).toContain(COUPON_KEYS.errors.code);
    expect(screen.queryByLabelText(F.totalLimit)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(F.code), { target: { value: "spring" } });
    fireEvent.change(screen.getByLabelText(F.value), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: /kit\.wizard\.next/ }));
    expect(await screen.findByLabelText(F.totalLimit)).toBeInTheDocument();
  });
});
