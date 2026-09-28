import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ManualRateCard } from "./ManualRateCard";

/**
 * A manual rate for any currency (F-116-l, `currency/contract.md`, D-53).
 *
 * > **The worker's reading is a suggestion, never a rate.**
 *
 * The rate box starts empty; a reading fills it only when clicked. A pin
 * prices every sale until it ends, so it is sent only after a confirm, and
 * afterwards the form is read again rather than patched from what was sent.
 */

const rates = vi.fn();
const pinForm = vi.fn();
const pin = vi.fn();
const endPin = vi.fn();

vi.mock("@/context/LocaleContext", () => ({ useLocale: () => ({ t, lang: "en" }) }));
vi.mock("@/lib/currency-api", () => ({
  currencyApi: {
    rates: (...a: unknown[]) => rates(...a),
    pinForm: (...a: unknown[]) => pinForm(...a),
    pin: (...a: unknown[]) => pin(...a),
    endPin: (...a: unknown[]) => endPin(...a),
  },
}));
vi.mock("@/hooks/useApiError", () => ({ useApiErrorMessage: () => () => "error" }));

const t = (_ns: string, key: string, values?: Record<string, unknown>) =>
  values ? `${key} ${JSON.stringify(values)}` : key;

const RATES = [
  { code: "USD", name: "US Dollar", isBase: true, rate: "1", pinned: null },
  { code: "IRR", name: "Iranian Rial", isBase: false, rate: "1050000", pinned: null },
  { code: "EUR", name: "Euro", isBase: false, rate: "0.92", pinned: null },
];

const FORM = {
  code: "IRR",
  current: null,
  platformPin: null,
  lastAccepted: { snapshotId: "s1", rate: "1050000", effectiveAt: "2026-09-28T00:00:00Z" },
  lastDownload: { rate: "1300000", at: "2026-09-28T01:00:00Z", outcome: "refused", used: 3, sources: 4, reason: "jump" },
};

const PIN = {
  id: "0b4b7c9e-8a0e-4c1e-9d55-111111111111",
  code: "IRR",
  rate: "1200000",
  reason: "market moved",
  setById: "u1",
  effectiveAt: "2026-09-28T02:00:00Z",
  expiresAt: "2026-09-29T02:00:00Z",
  endedAt: null,
};

const rateBox = () => screen.getByRole("textbox", { name: /manualRate\.rate/ }) as HTMLInputElement;
const setRate = () => screen.getByRole("button", { name: /manualRate\.pin$/ });

describe("the manual-rate card", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rates.mockResolvedValue(RATES);
    pinForm.mockResolvedValue(FORM);
    pin.mockResolvedValue(PIN);
    endPin.mockResolvedValue({ ...PIN, endedAt: "2026-09-28T03:00:00Z" });
  });

  it("offers every currency but the base, and reads the form for the one picked", async () => {
    render(<ManualRateCard scope="platform" />);
    await waitFor(() => expect(pinForm).toHaveBeenCalledWith("IRR"));
    const options = screen.getAllByRole("option").map((o) => (o as HTMLOptionElement).value);
    expect(options).toEqual(["IRR", "EUR"]);

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "EUR" } });
    await waitFor(() => expect(pinForm).toHaveBeenCalledWith("EUR"));
  });

  it("never fills the rate from the reading until the reading is clicked", async () => {
    render(<ManualRateCard scope="platform" />);
    const use = await screen.findByRole("button", { name: /manualRate\.useReading/ });
    expect(rateBox().value).toBe("");
    fireEvent.click(use);
    expect(rateBox().value).toBe("1300000");
  });

  it("pins only after the confirm, then reads the form again", async () => {
    render(<ManualRateCard scope="platform" />);
    await screen.findByRole("button", { name: /manualRate\.useReading/ });
    fireEvent.change(rateBox(), { target: { value: "1200000" } });
    fireEvent.change(screen.getByRole("textbox", { name: /manualRate\.reason/ }), { target: { value: "market moved" } });

    fireEvent.click(setRate());
    expect(pin).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /confirm\.yes/ }));

    await waitFor(() =>
      expect(pin).toHaveBeenCalledWith({ code: "IRR", rate: "1200000", reason: "market moved", hours: null }),
    );
    await waitFor(() => expect(pinForm).toHaveBeenCalledTimes(2));
  });

  it("sends the hours only when no end is unticked (F-116-n: no end is the default)", async () => {
    render(<ManualRateCard scope="platform" />);
    await screen.findByRole("button", { name: /manualRate\.useReading/ });
    expect(screen.getByRole("checkbox", { name: /manualRate\.noEnd/ })).toBeChecked();
    fireEvent.change(rateBox(), { target: { value: "1200000" } });
    fireEvent.change(screen.getByRole("textbox", { name: /manualRate\.reason/ }), { target: { value: "market moved" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /manualRate\.noEnd/ }));
    fireEvent.change(screen.getByRole("textbox", { name: /manualRate\.hours/ }), { target: { value: "48" } });

    fireEvent.click(setRate());
    fireEvent.click(screen.getByRole("button", { name: /confirm\.yes/ }));

    await waitFor(() => expect(pin).toHaveBeenCalledWith(expect.objectContaining({ hours: 48 })));
  });

  it("keeps the button off for a rate that is not a positive decimal", async () => {
    render(<ManualRateCard scope="platform" />);
    await screen.findByRole("button", { name: /manualRate\.useReading/ });
    fireEvent.change(screen.getByRole("textbox", { name: /manualRate\.reason/ }), { target: { value: "market moved" } });
    for (const bad of ["", "0", "-5", "1,200", "abc"]) {
      fireEvent.change(rateBox(), { target: { value: bad } });
      expect(setRate()).toBeDisabled();
    }
  });

  it("ends the caller's live pin", async () => {
    pinForm.mockResolvedValue({ ...FORM, current: PIN });
    render(<ManualRateCard scope="platform" />);
    fireEvent.click(await screen.findByRole("button", { name: /manualRate\.end/ }));
    await waitFor(() => expect(endPin).toHaveBeenCalledWith(PIN.id));
  });

  it("says a currency is not the reseller's in its own sentence", async () => {
    pinForm.mockRejectedValue({ reason: "currency_not_yours" });
    render(<ManualRateCard scope="reseller" />);
    expect(await screen.findByText("manualRate.refusals.currency_not_yours")).toBeInTheDocument();
  });
});
