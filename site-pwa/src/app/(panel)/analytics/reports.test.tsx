import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useRouter, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLocale } from "@/context/LocaleContext";
import { useLiveReread } from "@/hooks/useLiveReread";
import { readAnalytics } from "@/lib/billing/analytics";
import { type ReportSchedule, reportSchedulesApi } from "@/lib/billing/analytics-reports";
import { catalogApi } from "@/lib/catalog-api";
import { usePanelSession } from "../_context/PanelSessionContext";
import { AnalyticsView } from "./_components/AnalyticsView";
import { ReportsTab } from "./_components/ReportsTab";
import { reportBodyOf } from "./_lib/reports";

/**
 * The Reports tab (F-1006-b, panel-web `contract.analytics-tabs.md`
 * "Reports"; billing `contract.analytics-reports.md`). What goes wrong here
 * quietly:
 *
 *  - **a weekday on a daily report**, or none on a weekly one — the body says
 *    exactly what billing's CHECK holds;
 *  - **a report to nowhere**: no channel is refused here, and a channel the
 *    person cannot be reached on is offered with the reason, not silently;
 *  - **someone else's report sent or changed**: the owner sees another
 *    person's schedule, may pause or remove it, never send it;
 *  - **a poll**: the list re-reads on the person's own `billing.analytics.report`.
 */

vi.mock("next/navigation", () => ({ useRouter: vi.fn(), usePathname: () => "/analytics", useSearchParams: vi.fn() }));
vi.mock("@/context/LocaleContext", () => ({ useLocale: vi.fn() }));
vi.mock("@/context/ThemeContext", () => ({ useTheme: () => ({ theme: "light" }) }));
vi.mock("@/context/BrandContext", () => ({ useBrandColor: () => null }));
vi.mock("../_context/PanelSessionContext", () => ({ usePanelSession: vi.fn() }));
vi.mock("@/hooks/useLiveReread", () => ({ useLiveReread: vi.fn() }));
vi.mock("../_components/kit/DatePicker", () => ({ DatePicker: () => null }));
vi.mock("@/hooks/useApiError", () => ({ useApiErrorMessage: () => () => "generic" }));
vi.mock("@/lib/billing/analytics", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/billing/analytics")>()), readAnalytics: vi.fn() }));
vi.mock("@/lib/billing/analytics-reports", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing/analytics-reports")>()),
  reportSchedulesApi: { list: vi.fn(), create: vi.fn(), change: vi.fn(), remove: vi.fn(), sendNow: vi.fn() },
}));
vi.mock("@/lib/catalog-api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/catalog-api")>()), catalogApi: { texts: vi.fn() } }));

const TENANT = "11111111-1111-4111-8111-111111111111";
const ME = "44444444-4444-4444-8444-444444444444";
const t = (_ns: string, key: string, vars?: Record<string, string | number>) => (vars ? `${key}:${Object.values(vars).join(",")}` : key);
const me = { userId: ME, tenant: { id: TENANT, type: "reseller", isOwner: true }, permissions: ["analytics.read"] };

const schedule = (over: Partial<ReportSchedule>): ReportSchedule => ({
  id: "s1",
  userId: ME,
  frequency: "daily",
  weekday: null,
  hour: 9,
  calendar: "gregorian",
  tab: "overview",
  bot: true,
  email: false,
  paused: false,
  nextRunAt: "2026-10-17T05:30:00.000Z",
  lastSentAt: null,
  mine: true,
  name: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useRouter).mockReturnValue({ replace: vi.fn() } as unknown as ReturnType<typeof useRouter>);
  vi.mocked(useLocale).mockReturnValue({ lang: "en", isRtl: false, t } as unknown as ReturnType<typeof useLocale>);
  vi.mocked(usePanelSession).mockReturnValue({ me, isLoading: false } as unknown as ReturnType<typeof usePanelSession>);
  vi.mocked(catalogApi.texts).mockResolvedValue({});
});

describe("reportBodyOf", () => {
  const form = { frequency: "weekly" as const, weekday: 1, hour: 9, tab: "overview" as const, bot: true, email: false };

  it("sends a weekday with a weekly report only, in the reader's calendar", () => {
    expect(reportBodyOf(form, "jalali")).toEqual({ body: { ...form, calendar: "jalali" } });
    expect(reportBodyOf({ ...form, frequency: "daily" }, "gregorian")).toEqual({ body: { ...form, frequency: "daily", weekday: null, calendar: "gregorian" } });
  });

  it("refuses a report to nowhere", () => {
    expect(reportBodyOf({ ...form, bot: false }, "gregorian")).toEqual({ error: "noChannel" });
  });
});

describe("ReportsTab", () => {
  it("adds a schedule, says where the person cannot be reached, and re-reads on the person's own report event", async () => {
    vi.mocked(reportSchedulesApi.list).mockResolvedValue({ schedules: [], reach: { bot: true, email: false } });
    vi.mocked(reportSchedulesApi.create).mockResolvedValue(schedule({}));
    render(<ReportsTab tenantId={TENANT} calendar="gregorian" tabName={(tab) => tab} />);

    expect(await screen.findByText("analytics.reports.empty")).toBeTruthy();
    expect(screen.getByText("analytics.reports.form.emailUnreachable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "analytics.reports.form.add" }));
    await waitFor(() =>
      expect(reportSchedulesApi.create).toHaveBeenCalledWith(TENANT, { frequency: "daily", weekday: null, hour: 9, tab: "overview", bot: true, email: false, calendar: "gregorian" }),
    );
    expect(vi.mocked(useLiveReread).mock.calls.some(([channel, types]) => String(channel).includes(ME) && Array.isArray(types) && types.includes("billing.analytics.report"))).toBe(true);
  });

  it("lets the owner pause or remove another person's schedule, never send it", async () => {
    vi.mocked(reportSchedulesApi.list).mockResolvedValue({
      schedules: [schedule({}), schedule({ id: "s2", userId: "other", mine: false, name: "Sara" })],
      reach: { bot: true, email: true },
    });
    vi.mocked(reportSchedulesApi.sendNow).mockResolvedValue({ sent: true });
    render(<ReportsTab tenantId={TENANT} calendar="gregorian" tabName={(tab) => tab} />);

    const rows = await screen.findAllByRole("listitem");
    expect(within(rows[0]).getByRole("button", { name: "analytics.reports.sendNow" })).toBeTruthy();
    expect(within(rows[1]).getByText(/Sara/)).toBeTruthy();
    expect(within(rows[1]).queryByRole("button", { name: "analytics.reports.sendNow" })).toBeNull();
    expect(within(rows[1]).getByRole("button", { name: "analytics.reports.pause" })).toBeTruthy();

    fireEvent.click(within(rows[0]).getByRole("button", { name: "analytics.reports.sendNow" }));
    await waitFor(() => expect(reportSchedulesApi.sendNow).toHaveBeenCalledWith(TENANT, "s1"));
  });
});

describe("AnalyticsView on Reports", () => {
  it("offers the tab and reads the schedules, never a figure", async () => {
    vi.mocked(useSearchParams).mockReturnValue(new URLSearchParams("tab=reports") as unknown as ReturnType<typeof useSearchParams>);
    vi.mocked(reportSchedulesApi.list).mockResolvedValue({ schedules: [], reach: { bot: true, email: true } });
    render(<AnalyticsView />);
    expect(screen.getByRole("link", { name: "analytics.tabs.reports" })).toBeTruthy();
    await waitFor(() => expect(reportSchedulesApi.list).toHaveBeenCalledWith(TENANT));
    expect(readAnalytics).not.toHaveBeenCalled();
  });
});
