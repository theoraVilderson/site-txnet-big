import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { ApiError } from "@/lib/api-error";
import { billingApi, type GrantRow, type SpendingCap as Cap } from "@/lib/billing-api";
import { ServiceRow } from "./_components/ServiceRow";
import { SpendingCap } from "./_components/SpendingCap";
import { WalletFunds } from "./_components/WalletFunds";
import { capAmount, capReached } from "./_lib/spending-cap";

/**
 * The spending cap on one service, and held money shown apart (F-118-j,
 * `docs/interfaces/panel-web/contract.spending-cap.md`).
 *
 * > **Every figure is billing's.** Spent, held and left come from the cap's
 * > answer; available and held from the wallet's. Nothing here subtracts.
 *
 * > **Removing asks first**, because a service with no cap may spend the
 * > whole wallet — and "keep" is the focused answer.
 *
 * > **A refusal keeps what was typed**, with billing's sentence.
 */

vi.mock("@/context/LocaleContext", () => ({ useLocale: vi.fn() }));
vi.mock("@/lib/billing-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing-api")>()),
  billingApi: {
    spendingCap: vi.fn(),
    setSpendingCap: vi.fn(),
    removeSpendingCap: vi.fn(),
    subscriptionLink: vi.fn(),
    grantConfigs: vi.fn(),
    grantUsage: vi.fn(),
  },
}));

const K = FrontendI18nKeys.common.myServices.cap;
const t = (_ns: string, key: string, vars?: Record<string, string | number>) =>
  vars ? `${key}:${Object.values(vars).join(",")}` : key;

const readCap = vi.mocked(billingApi.spendingCap);
const setCap = vi.mocked(billingApi.setSpendingCap);
const removeCap = vi.mocked(billingApi.removeSpendingCap);

const CAP: Cap = {
  grantId: "g1",
  label: "Sara",
  amount: "20.00",
  currencyCode: "USD",
  period: "monthly",
  periodStartsAt: "2026-09-01T00:00:00.000Z",
  spent: "7.50",
  held: "2.25",
  left: "12.50",
};

const GRANT: GrantRow = {
  id: "g1",
  label: null,
  status: "active",
  startsAt: "2026-09-01T00:00:00.000Z",
  endsAt: null,
  featureKeys: [],
  variant: null,
  billingMode: "metered",
  consumedBytes: "0",
  purchasedBytes: "0",
  trafficUnlimited: false,
  trafficCapBytes: null,
  suspendedAt: null,
  purgeAt: null,
  lastTrafficAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useLocale).mockReturnValue({ lang: "en", t } as ReturnType<typeof useLocale>);
  vi.mocked(billingApi.grantConfigs).mockResolvedValue({ grantId: "g1", rows: [] });
  vi.mocked(billingApi.grantUsage).mockResolvedValue({ grantId: "g1", from: "", to: "", days: [] });
});

describe("an amount typed as a cap", () => {
  it("is billing's shape: above zero, at most two places", () => {
    expect(capAmount("20")).toBe("20");
    expect(capAmount(" 012.5 ")).toBe("12.5");
    expect(capAmount("150,000")).toBe("150000");
    expect(capAmount("0")).toBeNull();
    expect(capAmount("0.00")).toBeNull();
    expect(capAmount("1.005")).toBeNull();
    expect(capAmount("-3")).toBeNull();
    expect(capAmount("")).toBeNull();
  });

  it("reads the digits and the decimal mark a Persian keyboard types", () => {
    expect(capAmount("۱۵۰٬۰۰۰")).toBe("150000");
    expect(capAmount("۱۲٫۵")).toBe("12.5");
  });

  it("is spent when billing's `left` is zero, whatever is held", () => {
    expect(capReached({ ...CAP, left: "0.00" })).toBe(true);
    expect(capReached(CAP)).toBe(false);
  });
});

describe("the cap under manage", () => {
  it("is read only when manage opens, and not offered on a closed service", async () => {
    readCap.mockResolvedValue({ grantId: "g1", cap: null });
    const { unmount } = render(<ServiceRow row={GRANT} name="VPN" capabilities={[]} />);
    expect(readCap).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: FrontendI18nKeys.common.myServices.manage.open }));
    await screen.findByText(K.none);
    expect(readCap).toHaveBeenCalledWith("g1");
    unmount();

    render(<ServiceRow row={{ ...GRANT, status: "expired" }} name="VPN" capabilities={[]} />);
    await userEvent.click(screen.getByRole("button", { name: FrontendI18nKeys.common.myServices.manage.open }));
    expect(screen.queryByRole("region", { name: K.title })).toBeNull();
    expect(readCap).toHaveBeenCalledTimes(1);
  });

  it("shows billing's spent, held and left, and who it is for", async () => {
    readCap.mockResolvedValue({ grantId: "g1", cap: CAP });
    render(<SpendingCap grantId="g1" />);
    const section = await screen.findByRole("region", { name: K.title });
    expect(within(section).getByText("Sara")).toBeTruthy();
    expect(section.textContent).toContain("$7.50");
    expect(section.textContent).toContain("$2.25");
    expect(section.textContent).toContain("$12.50");
    expect(section.textContent).toContain("$20.00");
    expect(within(section).queryByText(K.reached)).toBeNull();
  });

  it("says the service is stopped when the cap is spent", async () => {
    readCap.mockResolvedValue({ grantId: "g1", cap: { ...CAP, spent: "20.00", held: "0.00", left: "0.00" } });
    render(<SpendingCap grantId="g1" />);
    expect(await screen.findByText(K.reached)).toBeTruthy();
  });

  it("sets a cap in billing's shape and shows billing's answer, then tells the page", async () => {
    readCap.mockResolvedValue({ grantId: "g1", cap: null });
    setCap.mockResolvedValue({ grantId: "g1", cap: { ...CAP, spent: "0.00", held: "0.00", left: "20.00" } });
    const onChanged = vi.fn();
    render(<SpendingCap grantId="g1" onChanged={onChanged} />);
    await userEvent.click(await screen.findByRole("button", { name: K.set }));
    await userEvent.type(screen.getByLabelText(K.label), "  Sara ");
    await userEvent.type(screen.getByLabelText(new RegExp(K.amount)), "۲۰");
    await userEvent.click(screen.getByRole("radio", { name: new RegExp(K.periodMonthly) }));
    await userEvent.click(screen.getByRole("button", { name: K.save }));

    await waitFor(() => expect(setCap).toHaveBeenCalledWith("g1", { label: "Sara", amount: "20", period: "monthly" }));
    const section = screen.getByRole("region", { name: K.title });
    await waitFor(() => expect(section.textContent).toContain("$20.00"));
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("sends nothing for an amount billing would refuse", async () => {
    readCap.mockResolvedValue({ grantId: "g1", cap: null });
    render(<SpendingCap grantId="g1" />);
    await userEvent.click(await screen.findByRole("button", { name: K.set }));
    await userEvent.type(screen.getByLabelText(K.label), "Sara");
    await userEvent.type(screen.getByLabelText(new RegExp(K.amount)), "0");
    await userEvent.click(screen.getByRole("button", { name: K.save }));
    expect(screen.getByText(K.invalidAmount)).toBeTruthy();
    expect(setCap).not.toHaveBeenCalled();
  });

  it("keeps what was typed on a refusal, with billing's sentence and ref", async () => {
    readCap.mockResolvedValue({ grantId: "g1", cap: CAP });
    setCap.mockRejectedValue(new ApiError("Billing says no.", { status: 400, ref: "R-1" }));
    render(<SpendingCap grantId="g1" />);
    await userEvent.click(await screen.findByRole("button", { name: K.edit }));
    const amount = screen.getByLabelText(new RegExp(K.amount)) as HTMLInputElement;
    expect(amount.value).toBe("20");
    await userEvent.clear(amount);
    await userEvent.type(amount, "30");
    await userEvent.click(screen.getByRole("button", { name: K.save }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Billing says no.");
    expect(alert.textContent).toContain("R-1");
    expect((screen.getByLabelText(new RegExp(K.amount)) as HTMLInputElement).value).toBe("30");
  });

  it("warns that a changed period counts again from today", async () => {
    readCap.mockResolvedValue({ grantId: "g1", cap: CAP });
    render(<SpendingCap grantId="g1" />);
    await userEvent.click(await screen.findByRole("button", { name: K.edit }));
    expect(screen.queryByText(K.periodRestarts)).toBeNull();
    await userEvent.click(screen.getByRole("radio", { name: new RegExp(K.periodNone) }));
    expect(screen.getByText(K.periodRestarts)).toBeTruthy();
  });

  it("asks before removing, with keep focused, and removes only on yes", async () => {
    readCap.mockResolvedValue({ grantId: "g1", cap: CAP });
    removeCap.mockResolvedValue(undefined);
    render(<SpendingCap grantId="g1" />);
    await userEvent.click(await screen.findByRole("button", { name: K.remove }));
    expect(screen.getByText(K.removeConfirm)).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: K.removeNo }));
    await userEvent.click(screen.getByRole("button", { name: K.removeNo }));
    expect(removeCap).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: K.remove }));
    await userEvent.click(screen.getByRole("button", { name: K.removeYes }));
    await waitFor(() => expect(removeCap).toHaveBeenCalledWith("g1"));
    expect(await screen.findByText(K.none)).toBeTruthy();
  });

  it("says a failed read, and offers to read again", async () => {
    readCap.mockRejectedValueOnce(new ApiError("Not now.", { status: 429 }));
    readCap.mockResolvedValueOnce({ grantId: "g1", cap: null });
    render(<SpendingCap grantId="g1" />);
    expect((await screen.findByRole("alert")).textContent).toContain("Not now.");
    await userEvent.click(screen.getByRole("button", { name: K.retry }));
    expect(await screen.findByText(K.none)).toBeTruthy();
  });
});

describe("the wallet on My services", () => {
  const W = FrontendI18nKeys.common.myServices.wallet;

  it("shows available and held apart, both as billing answered them", () => {
    render(<WalletFunds available="22.75" held="7.25" currencyCode="USD" failed={false} />);
    const strip = screen.getByRole("region", { name: W.title });
    expect(strip.textContent).toContain("$22.75");
    expect(strip.textContent).toContain("$7.25");
    expect(within(strip).getByText(W.held)).toBeTruthy();
  });

  it("says nothing about held money when none is held", () => {
    render(<WalletFunds available="30.00" held="0.00" currencyCode="USD" failed={false} />);
    expect(screen.queryByText(W.held)).toBeNull();
  });

  it("is not a zero when the read failed", () => {
    render(<WalletFunds available={null} held={null} currencyCode={null} failed />);
    expect(screen.getByText(W.unavailable)).toBeTruthy();
    expect(screen.queryByText(/\$0/)).toBeNull();
  });
});
