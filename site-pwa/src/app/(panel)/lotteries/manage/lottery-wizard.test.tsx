import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLocale } from "@/context/LocaleContext";
import { lotteryAdminApi, type AdminLottery } from "@/lib/engagement-api";
import { ConfirmProvider } from "../../_components/kit/confirm";
import { stepCheck } from "../../_components/prizes/prize-steps";
import { LOTTERY_ADMIN_KEYS as K, emptyLotteryForm, validateLotteryForm, wallClockToInstant } from "./_lib/lottery-admin";
import { CLOSE_SHORTCUTS, LOTTERY_STEPS, LOTTERY_STEP_HOLDS, closeAfterDays, newLotteryForm } from "./_lib/lottery-steps";
import { LotteryWizard } from "./_components/LotteryWizard";

/**
 * A lottery draft as a kit `Wizard` (UX-3-d, `contract.lotteries.md` rule 7):
 * title and group → close time and entry mode → rules → prizes → review with
 * the eligible count. What breaks with nothing red: a default close billing
 * refuses, a shortcut off the admin's wall clock, a field no step asks for, or
 * a saved draft that reopens on step one. Publish stays on the detail page.
 */

vi.mock("@/context/LocaleContext", () => ({ useLocale: vi.fn() }));
vi.mock("@/hooks/useApiError", () => ({ useApiErrorMessage: () => () => "failed" }));
vi.mock("@/lib/time-zone", () => ({ displayZone: () => "Asia/Tehran" }));
vi.mock("../../_context/PanelSessionContext", () => ({ usePanelSession: () => ({ me: null, isLoading: false }) }));
vi.mock("../../_hooks/usePrizeSources", () => ({ usePrizeSources: () => ({ templates: [] }) }));
vi.mock("../../_hooks/useAudienceGroups", () => ({ useAudienceGroups: () => [{ id: "g1", name: "VIP", givesKeys: false, userCount: 42 }] }));
vi.mock("@/lib/engagement-api", async (original) => ({
  ...(await original<object>()),
  lotteryAdminApi: { create: vi.fn(), replace: vi.fn(), eligibility: vi.fn() },
}));

const W = K.wizard;
const NOW = new Date("2026-10-18T09:10:00Z"); // 12:40 in Tehran

beforeEach(() => {
  vi.mocked(useLocale).mockReturnValue({ lang: "en", isRtl: false, t: (_ns: string, key: string) => key } as unknown as ReturnType<typeof useLocale>);
});

describe("the lottery steps", () => {
  it("put every field the check judges on exactly one step", () => {
    const check = validateLotteryForm({ ...emptyLotteryForm(), requiresMinAccountAgeHours: "x", reservesCount: "x" }, "UTC", NOW);
    const placed = Object.values(LOTTERY_STEP_HOLDS).flatMap((h) => (h === "prizes" ? [] : [...h]));
    expect(Object.keys(check.fields).every((k) => placed.includes(k as (typeof placed)[number]))).toBe(true);
    expect(new Set(placed).size).toBe(placed.length);
    expect(LOTTERY_STEPS.at(-1)).toBe("review");
    expect(Object.keys(stepCheck(check, LOTTERY_STEP_HOLDS.basics).fields).sort()).toEqual(["title", "userGroupId"]);
  });

  it("close a week out by default, on the admin's wall clock and a whole hour", () => {
    const form = newLotteryForm(NOW, "Asia/Tehran");
    expect(form.closesAt).toBe("2026-10-25T13:00");
    expect(validateLotteryForm(form, "Asia/Tehran", NOW).fields.closesAt).toBeUndefined();
  });

  it("make every shortcut at least its length ahead and inside billing's window", () => {
    for (const days of Object.values(CLOSE_SHORTCUTS)) {
      const at = Date.parse(wallClockToInstant(closeAfterDays(days, NOW, "Asia/Tehran"), "Asia/Tehran") as string);
      expect(at - NOW.getTime()).toBeGreaterThanOrEqual(days * 86_400_000);
      expect(validateLotteryForm({ ...emptyLotteryForm(), closesAt: closeAfterDays(days, NOW, "Asia/Tehran") }, "Asia/Tehran", NOW).fields.closesAt).toBeUndefined();
    }
  });
});

const DRAFT: AdminLottery = {
  id: "l1",
  userGroupId: "g1",
  title: "Autumn draw",
  description: null,
  entryMode: "automatic",
  status: "draft",
  closesAt: "2026-10-25T09:30:00Z",
  publishedAt: null,
  cancelledAt: null,
  cancelReason: null,
  requiresPhoneVerified: true,
  requiresMinAccountAgeHours: 24,
  reservesCount: 0,
  entrantCount: 0,
  winnersTotal: 1,
  prizes: [{ id: "p1", rank: 1, label: "5 GB", prizeType: "bonus_traffic_gb", prizeValue: "5", couponTemplateId: null, couponValidDays: null, variantId: null, winnersCount: 1 }],
} as unknown as AdminLottery;

describe("LotteryWizard", () => {
  const open = (from: AdminLottery | null) =>
    render(
      <ConfirmProvider>
        <LotteryWizard from={from} onClose={vi.fn()} onSaved={vi.fn()} />
      </ConfirmProvider>,
    );
  const next = () => fireEvent.click(screen.getByRole("button", { name: /kit\.wizard\.next/ }));

  it("keeps Next on the title and group until both are given", () => {
    open(null);
    next();
    expect(screen.getByText(K.errors.titleRequired)).toBeInTheDocument();
    expect(screen.getByText(K.errors.groupRequired)).toBeInTheDocument();
  });

  it("opens a saved draft on its review, with billing's eligible count", async () => {
    vi.mocked(lotteryAdminApi.eligibility).mockResolvedValue({ eligible: 17, members: 42, eligibleMembers: 17, candidates: 42, final: false } as never);
    open(DRAFT);
    expect(screen.getByRole("heading", { name: W.steps.review.title })).toBeInTheDocument();
    expect(await screen.findByText(K.eligibility.wouldGet)).toBeInTheDocument();
    expect(lotteryAdminApi.eligibility).toHaveBeenCalledWith("l1");
    fireEvent.click(screen.getAllByRole("button", { name: W.edit })[1]);
    const box = (await screen.findByDisplayValue(/^2026-10-25T/)) as HTMLInputElement;
    fireEvent.click(screen.getByRole("button", { name: W.shortcuts.day }));
    expect(box.value).toBe(closeAfterDays(CLOSE_SHORTCUTS.day, new Date(), "Asia/Tehran"));
  });
});
