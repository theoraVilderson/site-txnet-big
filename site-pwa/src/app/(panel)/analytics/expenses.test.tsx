import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useRouter, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLocale } from "@/context/LocaleContext";
import { useLiveReread } from "@/hooks/useLiveReread";
import { ApiError } from "@/lib/api-error";
import { type AnalyticsMargin, readAnalytics } from "@/lib/billing/analytics";
import { type Expense, expensesApi } from "@/lib/billing/analytics-expenses";
import { catalogApi } from "@/lib/catalog-api";
import { currencyApi } from "@/lib/currency-api";
import { usePanelSession } from "../_context/PanelSessionContext";
import { AnalyticsView } from "./_components/AnalyticsView";
import { ExpensesTab } from "./_components/ExpensesTab";
import { ProfitTab } from "./_components/ProfitTab";
import { expenseBodyOf, expensesVisible } from "./_lib/expenses";

/**
 * The Expenses tab and the net-profit line (F-1001-u, panel-web
 * `contract.analytics-tabs.md` "Expenses"; billing
 * `contract.analytics-expenses.md`). What goes wrong here quietly:
 *
 *  - **a float for money.** The body sends the amount as the string typed,
 *    checked as billing checks it — above zero, at most four places;
 *  - **a correction that edits.** There is no edit: a row is taken back, and
 *    a taken-back one says so and offers nothing more;
 *  - **another tenant's ledger.** The platform's view of a reseller's
 *    workspace offers no Expenses tab — billing would refuse it;
 *  - **a poll.** The list re-reads on the tenant's analytics event;
 *  - **net profit drawn from nothing.** The line shows only where billing
 *    answers it, says a loss in words, and links to where expenses are kept.
 */

vi.mock("next/navigation", () => ({ useRouter: vi.fn(), usePathname: () => "/analytics", useSearchParams: vi.fn() }));
vi.mock("@/context/LocaleContext", () => ({ useLocale: vi.fn() }));
vi.mock("@/context/ThemeContext", () => ({ useTheme: () => ({ theme: "light" }) }));
vi.mock("@/context/BrandContext", () => ({ useBrandColor: () => null }));
vi.mock("@visx/responsive", () => ({ ParentSize: ({ children }: { children: (s: { width: number; height: number }) => unknown }) => children({ width: 360, height: 220 }) }));
vi.mock("../_context/PanelSessionContext", () => ({ usePanelSession: vi.fn() }));
vi.mock("@/hooks/useLiveReread", () => ({ useLiveReread: vi.fn() }));
vi.mock("../_components/kit/DatePicker", () => ({
  DatePicker: ({ label, value, onChange }: { label?: string; value: string | null; onChange: (v: string | null) => void }) => (
    <input aria-label={label} value={value ?? ""} onChange={(e) => onChange(e.target.value || null)} />
  ),
}));
vi.mock("@/hooks/useApiError", () => ({ useApiErrorMessage: () => () => "generic" }));
vi.mock("@/lib/billing/analytics", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/billing/analytics")>()), readAnalytics: vi.fn() }));
vi.mock("@/lib/billing/analytics-expenses", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing/analytics-expenses")>()),
  expensesApi: { list: vi.fn(), add: vi.fn(), takeBack: vi.fn() },
}));
vi.mock("@/lib/currency-api", () => ({ currencyApi: { rates: vi.fn() } }));
vi.mock("@/lib/catalog-api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/catalog-api")>()), catalogApi: { texts: vi.fn() } }));

const TENANT = "11111111-1111-4111-8111-111111111111";
const RESELLER = "22222222-2222-4222-8222-222222222222";
const t = (_ns: string, key: string, vars?: Record<string, string | number>) => (vars ? `${key}:${Object.values(vars).join(",")}` : key);
const params = (query: string) => new URLSearchParams(query) as unknown as ReturnType<typeof useSearchParams>;
const owner = { userId: "u", tenant: { id: TENANT, type: "reseller", isOwner: true }, permissions: ["analytics.read", "settings.manage", "realtime.tenant.read"] };

const expense = (over: Partial<Expense>): Expense => ({
  id: "e1",
  category: "domain",
  amount: "120.00",
  currencyCode: "USD",
  spentOn: "2026-10-01",
  months: 12,
  note: "brand.ir",
  createdByUserId: "u",
  createdAt: "2026-10-19T08:00:00.000Z",
  takenBackAt: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useRouter).mockReturnValue({ replace: vi.fn(), push: vi.fn() } as unknown as ReturnType<typeof useRouter>);
  vi.mocked(useLocale).mockReturnValue({ lang: "en", isRtl: false, t } as unknown as ReturnType<typeof useLocale>);
  vi.mocked(usePanelSession).mockReturnValue({ me: owner, isLoading: false } as unknown as ReturnType<typeof usePanelSession>);
  vi.mocked(catalogApi.texts).mockResolvedValue({});
  vi.mocked(currencyApi.rates).mockResolvedValue([
    { code: "USD", name: "US Dollar", symbol: "$", decimalPlaces: 2, isBase: true } as never,
    { code: "IRT", name: "Toman", symbol: "T", decimalPlaces: 0, isBase: false } as never,
  ]);
  vi.mocked(expensesApi.list).mockResolvedValue({ expenses: [expense({}), expense({ id: "e2", category: "advertising", amount: "31.00", months: 1, note: null, takenBackAt: "2026-10-19T09:00:00.000Z" })], more: false, currencyCode: "IRT" });
});

describe("expenseBodyOf", () => {
  const form = { category: "rent" as const, amount: "250", currencyCode: "USD", spentOn: "2026-10-19", months: "1", note: "" };

  it("sends the amount as typed, the months as a number and no empty note", () => {
    expect(expenseBodyOf(form, "2026-10-19")).toEqual({ body: { category: "rent", amount: "250", currencyCode: "USD", spentOn: "2026-10-19", months: 1 } });
    expect(expenseBodyOf({ ...form, note: " shop " }, "2026-10-19")).toEqual({ body: expect.objectContaining({ note: "shop" }) });
  });

  it("refuses what billing would, before asking", () => {
    expect(expenseBodyOf({ ...form, amount: "0" }, "2026-10-19")).toEqual({ error: "amount" });
    expect(expenseBodyOf({ ...form, amount: "1.23456" }, "2026-10-19")).toEqual({ error: "amount" });
    expect(expenseBodyOf({ ...form, amount: "1e3" }, "2026-10-19")).toEqual({ error: "amount" });
    expect(expenseBodyOf({ ...form, months: "61" }, "2026-10-19")).toEqual({ error: "months" });
    expect(expenseBodyOf({ ...form, spentOn: "2026-10-20" }, "2026-10-19")).toEqual({ error: "spentOn" });
    expect(expenseBodyOf({ ...form, spentOn: null }, "2026-10-19")).toEqual({ error: "spentOn" });
  });
});

describe("expensesVisible", () => {
  it("is the session's own tenant, or a reseller's owner on its own workspace — never the platform on a reseller's", () => {
    expect(expensesVisible({})).toBe(true);
    expect(expensesVisible({ tenantId: RESELLER, self: true })).toBe(true);
    expect(expensesVisible({ tenantId: RESELLER })).toBe(false);
  });
});

describe("ExpensesTab", () => {
  it("lists each expense, a taken-back one marked and with nothing to do, and re-reads on the analytics event", async () => {
    render(<ExpensesTab tenantId={TENANT} editable today="2026-10-19" />);
    const list = await screen.findByRole("list", { name: "analytics.expenses.title" });
    const [kept, gone] = within(list).getAllByRole("listitem");
    expect(within(kept).getByText(/analytics\.expenses\.categories\.domain/)).toBeTruthy();
    expect(within(kept).getByText(/brand\.ir/)).toBeTruthy();
    expect(within(kept).getByRole("button", { name: "analytics.expenses.takeBack" })).toBeTruthy();
    expect(within(gone).getByText("analytics.expenses.takenBack")).toBeTruthy();
    expect(within(gone).queryByRole("button")).toBeNull();
    expect(vi.mocked(useLiveReread).mock.calls.some((c) => c[0] === `tenant:${TENANT}` && c[1].includes("billing.analytics.refreshed"))).toBe(true);
  });

  it("adds one in the tenant's currency by default, and takes one back", async () => {
    vi.mocked(expensesApi.add).mockResolvedValue(expense({ id: "e3" }));
    vi.mocked(expensesApi.takeBack).mockResolvedValue(expense({ takenBackAt: "2026-10-19T10:00:00.000Z" }));
    render(<ExpensesTab tenantId={TENANT} editable today="2026-10-19" />);
    await screen.findByRole("list", { name: "analytics.expenses.title" });
    fireEvent.change(screen.getByLabelText("analytics.expenses.form.amount"), { target: { value: "500000" } });
    fireEvent.click(screen.getByRole("button", { name: "analytics.expenses.form.add" }));
    await waitFor(() => expect(expensesApi.add).toHaveBeenCalledWith(TENANT, expect.objectContaining({ amount: "500000", currencyCode: "IRT", spentOn: "2026-10-19", months: 1 })));
    fireEvent.click(screen.getAllByRole("button", { name: "analytics.expenses.takeBack" })[0]);
    await waitFor(() => expect(expensesApi.takeBack).toHaveBeenCalledWith(TENANT, "e1"));
  });

  it("says billing's refusal in words", async () => {
    vi.mocked(expensesApi.add).mockRejectedValue(new ApiError("refused", { status: 400, reason: "amount_finer_than_currency" }));
    render(<ExpensesTab tenantId={TENANT} editable today="2026-10-19" />);
    await screen.findByRole("list", { name: "analytics.expenses.title" });
    fireEvent.change(screen.getByLabelText("analytics.expenses.form.amount"), { target: { value: "5.5" } });
    fireEvent.click(screen.getByRole("button", { name: "analytics.expenses.form.add" }));
    expect(await screen.findByText("analytics.expenses.refusals.amountFinerThanCurrency")).toBeTruthy();
  });

  it("draws no form and no take back for a reader who may not change them", async () => {
    render(<ExpensesTab tenantId={TENANT} editable={false} today="2026-10-19" />);
    await screen.findByRole("list", { name: "analytics.expenses.title" });
    expect(screen.queryByLabelText("analytics.expenses.form.amount")).toBeNull();
    expect(screen.queryByRole("button", { name: "analytics.expenses.takeBack" })).toBeNull();
  });
});

describe("AnalyticsView and the Expenses tab", () => {
  it("offers the tab on the tenant's own view and reads no figure there", async () => {
    vi.mocked(useSearchParams).mockReturnValue(params("tab=expenses"));
    render(<AnalyticsView />);
    expect(screen.getAllByText("analytics.tabs.expenses").length).toBeGreaterThan(0);
    await waitFor(() => expect(expensesApi.list).toHaveBeenCalledWith(TENANT, {}));
    expect(readAnalytics).not.toHaveBeenCalled();
  });

  it("offers no Expenses tab to the platform on a reseller's workspace", () => {
    vi.mocked(useSearchParams).mockReturnValue(params("tab=expenses"));
    vi.mocked(readAnalytics).mockReturnValue(new Promise(() => undefined));
    render(<AnalyticsView tenantId={RESELLER} />);
    expect(screen.queryByText("analytics.tabs.expenses")).toBeNull();
    expect(expensesApi.list).not.toHaveBeenCalled();
  });
});

describe("ProfitTab's net-profit line", () => {
  const usd = (v: string) => ({ USD: v });
  const money = (v: string) => ({ value: usd(v), previous: usd("0.00"), delta: { USD: "new" as const } });
  const margin: AnalyticsMargin = {
    currencies: ["USD"],
    totals: { net: money("10.00"), cost: money("7.25"), margin: money("2.75"), marginRate: 0.275, previousMarginRate: null, overhead: money("6.25"), netProfit: money("-3.50") },
    costParts: { attributed: usd("7.25"), idle: usd("0.00"), unallocated: usd("0.00") },
    series: { net: [], cost: [], margin: [] },
    products: [],
    panels: [],
    users: [],
    resellers: null,
    noCostPanels: null,
    noCostProducts: [],
    lossAlertPercent: 20,
  };
  const draw = (body: Partial<AnalyticsMargin["totals"]>, expensesHref: string | null = "/analytics?tab=expenses") =>
    render(
      <ProfitTab
        margin={{ ...margin, totals: { ...margin.totals, ...body } }}
        x={[]}
        currency="USD"
        productName={() => null}
        panelName={() => null}
        userHref={(id) => `/users/${id}`}
        catalogHref="/catalog"
        expensesHref={expensesHref}
        setting={null}
        stale={false}
      />,
    );

  it("draws general expenses and net profit, a loss in words, with a link to the expenses", () => {
    draw({});
    const line = screen.getByRole("region", { name: "analytics.profit.netProfit.title" });
    expect(within(line).getByText("analytics.profit.kpis.overhead")).toBeTruthy();
    expect(within(line).getByText("analytics.profit.kpis.netProfit")).toBeTruthy();
    expect(within(line).getByText("analytics.profit.loss")).toBeTruthy();
    expect(within(line).getByRole("link").getAttribute("href")).toBe("/analytics?tab=expenses");
  });

  it("says why there is no net profit under a filter, and draws nothing where billing answers none for the view", () => {
    draw({ overhead: null, netProfit: null });
    expect(screen.getByText("analytics.profit.netProfit.filtered")).toBeTruthy();
    draw({ overhead: null, netProfit: null }, null);
    expect(screen.getAllByText("analytics.profit.netProfit.filtered")).toHaveLength(1);
  });
});
