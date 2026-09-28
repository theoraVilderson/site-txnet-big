import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { OperatingCurrencyCard } from "./OperatingCurrencyCard";

/**
 * Picking a tenant's operating currency (F-116-h, `tenant/contract.currency.md`).
 *
 * > **A change converts the tenant's money, so it is never one click.**
 *
 * `PUT` converts every wallet, active price, coupon and gateway limit at one
 * rate snapshot (rule 3). The card sends it only after the admin confirms a
 * sentence naming both currencies, and afterwards says what was converted
 * and at what rate — from the answer, never from what was picked. A change
 * another admin won first (`currency_changed`) is re-read, not retried blind.
 */

const get = vi.fn();
const set = vi.fn();

vi.mock("@/context/LocaleContext", () => ({ useLocale: () => ({ t, lang: "en" }) }));
vi.mock("@/lib/tenant-api", () => ({
  operatingCurrencyApi: {
    get: (...a: unknown[]) => get(...a),
    set: (...a: unknown[]) => set(...a),
  },
}));
vi.mock("@/hooks/useApiError", () => ({ useApiErrorMessage: () => () => "error" }));

/** The key back, with its values, so an assertion names what the component asked for. */
const t = (_ns: string, key: string, values?: Record<string, unknown>) =>
  values ? `${key} ${JSON.stringify(values)}` : key;

const CHOICES = [
  { code: "USD", name: "US Dollar", symbol: "$", decimalPlaces: 2 },
  { code: "EUR", name: "Euro", symbol: "€", decimalPlaces: 2 },
];

const SUMMARY = {
  wallets: 12,
  prices: 4,
  meteredRates: 0,
  grants: 0,
  coupons: 1,
  rules: 0,
  depositSettings: 0,
  gateways: 0,
  invoicesCancelled: 0,
  billingWallets: 0,
  packages: 0,
  usageMeters: 0,
};

const pick = (code: string) => fireEvent.change(screen.getByRole("combobox"), { target: { value: code } });
const change = () => screen.getByRole("button", { name: /\.change$/ });

describe("the operating currency card", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    get.mockResolvedValue({ code: "USD", choices: CHOICES });
    set.mockResolvedValue({
      code: "EUR",
      choices: CHOICES,
      conversion: { changeId: "c1", fromCode: "USD", rate: "0.92", summary: SUMMARY },
    });
  });

  it("reads the tenant it is given and offers nothing to change until another currency is picked", async () => {
    render(<OperatingCurrencyCard tenantId="t1" scope="reseller" />);
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveValue("USD"));
    expect(get).toHaveBeenCalledWith("t1");
    expect(change()).toBeDisabled();
    pick("EUR");
    expect(change()).toBeEnabled();
  });

  it("converts nothing until the admin confirms, then sends only the code", async () => {
    render(<OperatingCurrencyCard tenantId="t1" scope="reseller" />);
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveValue("USD"));
    pick("EUR");
    fireEvent.click(change());

    expect(set).not.toHaveBeenCalled();
    expect(screen.getByText(/confirm\.body/)).toHaveTextContent('"from":"USD"');
    expect(screen.getByText(/confirm\.body/)).toHaveTextContent('"to":"EUR"');

    fireEvent.click(screen.getByRole("button", { name: /confirm\.yes$/ }));
    await waitFor(() => expect(set).toHaveBeenCalledWith("t1", "EUR"));
  });

  it("says what was converted, from the answer: the rate and only the kinds that moved", async () => {
    render(<OperatingCurrencyCard tenantId="t1" scope="reseller" />);
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveValue("USD"));
    pick("EUR");
    fireEvent.click(change());
    fireEvent.click(screen.getByRole("button", { name: /confirm\.yes$/ }));

    const done = await screen.findByText(/done\.title/);
    expect(done).toHaveTextContent('"rate":"0.92"');
    expect(screen.getByText(/summary\.wallets/)).toHaveTextContent('"count":12');
    expect(screen.getByText(/summary\.coupons/)).toHaveTextContent('"count":1');
    expect(screen.queryByText(/summary\.gateways/)).toBeNull();
    expect(screen.getByRole("combobox")).toHaveValue("EUR");
  });

  it("warns the platform that every reseller's billing moves with it", async () => {
    render(<OperatingCurrencyCard tenantId="p1" scope="platform" />);
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveValue("USD"));
    pick("EUR");
    fireEvent.click(change());
    expect(screen.getByText(/confirm\.platform$/)).toBeInTheDocument();
  });

  it("re-reads the currency when another change won the race", async () => {
    set.mockRejectedValueOnce(Object.assign(new Error("conflict"), { reason: "currency_changed" }));
    render(<OperatingCurrencyCard tenantId="t1" scope="reseller" />);
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveValue("USD"));
    pick("EUR");
    fireEvent.click(change());
    fireEvent.click(screen.getByRole("button", { name: /confirm\.yes$/ }));

    expect(await screen.findByText(/refusals\.currency_changed$/)).toBeInTheDocument();
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  });
});
