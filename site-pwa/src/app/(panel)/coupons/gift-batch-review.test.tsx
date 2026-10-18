import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLocale } from "@/context/LocaleContext";
import { billingApi } from "@/lib/billing-api";
import type { Me } from "@/lib/auth-api";
import { COUPON_KEYS } from "./_lib/coupon-form";
import { GIFT_CODE_ALPHABET, GIFT_CODE_BODY_LENGTH, GIFT_KEYS, batchTotal, emptyGiftBatchForm, sampleGiftCodes, validateGiftBatch } from "./_lib/gift-batch";
import { GiftBatchSheet } from "./_components/GiftBatchSheet";

/**
 * A gift batch is reviewed before it is generated (UX-3-e,
 * `contract.coupons.md` rule 10): a batch cannot be undone, so the sheet
 * shows sample codes in billing's own shape, count × value, what each code
 * gives and its end, and generates only on the second click. The amount is
 * named in the currency billing will write it in (F-116-h11), and held to
 * that currency's places.
 */

vi.mock("@/context/LocaleContext", () => ({ useLocale: vi.fn() }));
vi.mock("../_components/kit/DatePicker", () => ({ DatePicker: () => null }));
vi.mock("@/hooks/useApiError", () => ({ useApiErrorMessage: () => () => "failed" }));
vi.mock("@/lib/billing-api", async (original) => ({ ...(await original<object>()), billingApi: { generateGiftBatch: vi.fn(), couponCurrency: vi.fn() } }));

const REPO = join(__dirname, "../../../../..");
const BATCH_SERVICE = join(REPO, "txnet-backend/billing-service/src/app/payment/coupon-admin/coupon-batch.service.ts");
const RESELLER_ID = "33333333-3333-4333-8333-333333333333";
const RESELLER: Me = {
  userId: "u1",
  fullName: "Theora",
  role: { id: "r1", name: "Admin" },
  permissions: ["coupon.manage"],
  tenant: { id: RESELLER_ID, type: "reseller", isOwner: true },
  email: null,
  isImpersonated: false,
};
const F = GIFT_KEYS.form;
const R = F.review;

beforeEach(() => {
  vi.mocked(useLocale).mockReturnValue({
    lang: "en",
    isRtl: false,
    t: (_ns: string, key: string, vars?: Record<string, unknown>) => (vars ? `${key} ${Object.values(vars).join(" ")}` : key),
  } as unknown as ReturnType<typeof useLocale>);
  vi.mocked(billingApi.generateGiftBatch).mockReset();
  vi.mocked(billingApi.couponCurrency).mockReset().mockResolvedValue({ code: "USD" });
});

describe("a batch's value in its currency (F-116-h11)", () => {
  const valid = { ...emptyGiftBatchForm(), label: "Yalda", count: "50", value: "5.5" };

  it("is held to the currency's places once billing has named it", () => {
    expect(validateGiftBatch(valid, RESELLER, "IRR")).toMatchObject({ value: COUPON_KEYS.errors.decimal });
    expect(validateGiftBatch(valid, RESELLER, "USD")).toEqual({});
    expect(validateGiftBatch({ ...valid, value: "5.5555" }, RESELLER, null)).toEqual({});
  });
});

describe("sampleGiftCodes", () => {
  it("draws from billing's own alphabet and length", () => {
    const source = readFileSync(BATCH_SERVICE, "utf8");
    expect(source).toContain(`export const GIFT_CODE_ALPHABET = '${GIFT_CODE_ALPHABET}';`);
    expect(source).toContain(`const BODY_LENGTH = ${GIFT_CODE_BODY_LENGTH};`);
  });

  it("puts the upper-cased prefix and a dash before the body, as billing does", () => {
    const body = new RegExp(`^YLD-[${GIFT_CODE_ALPHABET}]{${GIFT_CODE_BODY_LENGTH}}$`);
    const codes = sampleGiftCodes(" yld ", 50);
    expect(codes).toHaveLength(3);
    codes.forEach((c) => expect(c).toMatch(body));
    sampleGiftCodes("", 50).forEach((c) => expect(c).toMatch(new RegExp(`^[${GIFT_CODE_ALPHABET}]{${GIFT_CODE_BODY_LENGTH}}$`)));
  });

  it("shows no more samples than the batch has codes", () => {
    expect(sampleGiftCodes("", 1)).toHaveLength(1);
  });
});

describe("batchTotal", () => {
  it.each([
    ["5", 50, "250"],
    ["2.5", 3, "7.5"],
    ["0.0001", 5000, "0.5"],
    ["1250000", 5000, "6250000000"],
  ])("%s × %d is %s, with no float (C-02)", (value, count, total) => {
    expect(batchTotal(value, count)).toBe(total);
  });
});

describe("GiftBatchSheet", () => {
  const open = (onCreated = vi.fn()) => render(<GiftBatchSheet me={RESELLER} onClose={vi.fn()} onCreated={onCreated} />);
  const fill = () => {
    fireEvent.change(screen.getByLabelText(F.label), { target: { value: "Yalda" } });
    fireEvent.change(screen.getByLabelText(F.count), { target: { value: "50" } });
    fireEvent.change(screen.getByLabelText(F.value), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText(F.prefix), { target: { value: "yld" } });
  };

  it("stays on the form while it has an error", async () => {
    open();
    await screen.findByText(`${F.valueHint} USD`);
    fireEvent.click(screen.getByRole("button", { name: R.open }));
    expect(screen.getAllByRole("alert").map((a) => a.textContent)).toContain(GIFT_KEYS.errors.label);
    expect(screen.queryByText(R.irreversible)).not.toBeInTheDocument();
  });

  it("names the currency billing will write the batch in, for the batch's owner", async () => {
    open();
    expect(await screen.findByText(`${F.valueHint} USD`)).toBeInTheDocument();
    expect(billingApi.couponCurrency).toHaveBeenCalledWith(RESELLER_ID);
  });

  it("reviews the batch before generating anything", async () => {
    open();
    fill();
    await screen.findByText(`${F.valueHint} USD`);
    fireEvent.click(screen.getByRole("button", { name: R.open }));
    expect(billingApi.generateGiftBatch).not.toHaveBeenCalled();
    expect(screen.getByText(R.irreversible)).toBeInTheDocument();
    expect(screen.getByText(`${R.total} $250.00`)).toBeInTheDocument();
    expect(screen.getByText(R.neverExpires)).toBeInTheDocument();
    expect(screen.getAllByText(/^YLD-/)).toHaveLength(3);
  });

  it("goes back to the form with every field kept", async () => {
    open();
    await screen.findByText(`${F.valueHint} USD`);
    fill();
    fireEvent.click(screen.getByRole("button", { name: R.open }));
    fireEvent.click(screen.getByRole("button", { name: R.back }));
    expect(screen.getByLabelText(F.label)).toHaveValue("Yalda");
    expect(screen.getByLabelText(F.count)).toHaveValue("50");
  });

  it("generates once, on the review's own button", async () => {
    vi.mocked(billingApi.generateGiftBatch).mockResolvedValue({ id: "b1", label: "Yalda", codes: 50 } as never);
    const onCreated = vi.fn();
    open(onCreated);
    fill();
    fireEvent.click(screen.getByRole("button", { name: R.open }));
    fireEvent.click(screen.getByRole("button", { name: `${R.confirm} 50` }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(billingApi.generateGiftBatch).toHaveBeenCalledTimes(1);
    expect(billingApi.generateGiftBatch).toHaveBeenCalledWith({ label: "Yalda", count: 50, value: "5", prefix: "YLD" });
  });
});
