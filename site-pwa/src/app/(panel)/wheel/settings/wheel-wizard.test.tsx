import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLocale } from "@/context/LocaleContext";
import { wheelAdminApi } from "@/lib/engagement-api";
import { ConfirmProvider } from "../../_components/kit/confirm";
import { firstFailingStep, stepCheck } from "../../_components/prizes/prize-steps";
import { WHEEL_SETTINGS_KEYS as K, emptyPrize, emptyWheelForm, oddsPercents, validateWheelForm, type WheelForm } from "./_lib/wheel-settings";
import { WHEEL_STEPS, WHEEL_STEP_HOLDS, slotsUntouched, starterPrizes } from "./_lib/wheel-steps";
import { WheelWizard } from "./_components/WheelWizard";

/**
 * A new wheel version as a kit `Wizard` (UX-3-c, `contract.wheel.md` rule 7):
 * cap and on/off → who may spin → prizes with the disc and each slot's odds →
 * review. What breaks with nothing red: a step that lets a wrong field through
 * to billing, a field no step asks for, or a starter set billing would refuse.
 * The rules stay `validateWheelForm`'s; a save is still a new version.
 */

vi.mock("@/context/LocaleContext", () => ({ useLocale: vi.fn() }));
vi.mock("@/hooks/useApiError", () => ({ useApiErrorMessage: () => () => "failed" }));
vi.mock("../../_context/PanelSessionContext", () => ({ usePanelSession: () => ({ me: null, isLoading: false }) }));
vi.mock("../../_hooks/usePrizeSources", () => ({ usePrizeSources: () => ({ templates: [] }) }));
vi.mock("../../_hooks/useAudienceGroups", () => ({ useAudienceGroups: () => [] }));
vi.mock("@/lib/engagement-api", async (original) => ({ ...(await original<object>()), wheelAdminApi: { save: vi.fn() } }));

const W = K.wizard;
const LABELS = { tryAgain: "Try again", gb: (n: number) => `${n} GB`, days: (n: number) => `${n} d` };

beforeEach(() => {
  vi.mocked(useLocale).mockReturnValue({ lang: "en", isRtl: false, t: (_ns: string, key: string) => key } as unknown as ReturnType<typeof useLocale>);
  vi.mocked(wheelAdminApi.save).mockReset();
});

const priced = (f: WheelForm): WheelForm => ({ ...f, cap: "100000", prizes: f.prizes.map((p) => ({ ...p, costAmount: p.costAmount || "500" })) });

describe("the wheel steps", () => {
  it("put every field the check judges on exactly one step, the prizes on their own", () => {
    const check = validateWheelForm({ ...emptyWheelForm(), cooldownHours: "x", maxSpins: "x", minAgeHours: "x", minPaid: "x", minOrders: "x" }, 0);
    const placed = Object.values(WHEEL_STEP_HOLDS).flatMap((h) => (h === "prizes" ? [] : [...h]));
    expect(Object.keys(check.fields).every((k) => placed.includes(k as (typeof placed)[number]))).toBe(true);
    expect(new Set(placed).size).toBe(placed.length);
    expect(WHEEL_STEPS.at(-1)).toBe("review");
  });

  it("stop a step only on its own errors, and the prizes on the average over the cap", () => {
    const check = validateWheelForm({ ...emptyWheelForm(), maxSpins: "0" }, 0);
    expect(Object.keys(stepCheck(check, WHEEL_STEP_HOLDS.basics).fields)).toEqual(["cap"]);
    expect(Object.keys(stepCheck(check, WHEEL_STEP_HOLDS.eligibility).fields)).toEqual(["maxSpins"]);
    const dear = priced({ ...emptyWheelForm(), prizes: starterPrizes(LABELS) });
    // 40 of 130 weight at 500 is ~154 a spin: over a 150 cap.
    const over = validateWheelForm({ ...dear, cap: "150" }, 0);
    expect(stepCheck(over, WHEEL_STEP_HOLDS.basics).ok).toBe(true);
    expect(stepCheck(over, WHEEL_STEP_HOLDS.prizes).overall).toBe(K.errors.expectedOverCap);
    expect(firstFailingStep(over, WHEEL_STEP_HOLDS)).toBe("prizes");
  });
});

describe("the starter set", () => {
  it("is a wheel billing takes once the prizes are priced, misses costing nothing", () => {
    const slots = starterPrizes(LABELS);
    expect(slots.length).toBeGreaterThanOrEqual(2);
    expect(slots.filter((p) => p.prizeType === "empty").every((p) => p.costAmount === "0")).toBe(true);
    expect(validateWheelForm({ ...emptyWheelForm(), prizes: slots }, 0).ok).toBe(false);
    expect(validateWheelForm(priced({ ...emptyWheelForm(), prizes: slots }), 0).ok).toBe(true);
    const odds = oddsPercents(slots.map((p) => p.weight));
    expect(odds?.reduce((s, o) => s + Number(o), 0)).toBeCloseTo(100, 1);
  });

  it("is offered only while no slot was touched", () => {
    expect(slotsUntouched(emptyWheelForm().prizes)).toBe(true);
    expect(slotsUntouched([{ ...emptyPrize(), label: "x" }, emptyPrize()])).toBe(false);
  });
});

describe("WheelWizard", () => {
  /** A field's own label: the hint under it is part of the label's text. */
  const label = (key: string) => new RegExp(`^${key.replace(/\./g, "\\.")}`);
  const next = () => fireEvent.click(screen.getByRole("button", { name: /kit\.wizard\.next/ }));
  const open = () =>
    render(
      <ConfirmProvider>
        <WheelWizard from={null} today="2026-10-18" currency="IRT" onClose={vi.fn()} onSaved={vi.fn()} />
      </ConfirmProvider>,
    );
  const pastBasics = async () => {
    fireEvent.change(screen.getByLabelText(label(K.fields.cap)), { target: { value: "100000" } });
    next();
    await screen.findByLabelText(label(K.fields.maxSpins));
  };

  it("keeps Next on the cap until it is typed, then asks who may spin", async () => {
    open();
    next();
    expect(screen.getByText(K.errors.amount)).toBeInTheDocument();
    expect(screen.queryByLabelText(label(K.fields.maxSpins))).not.toBeInTheDocument();
    await pastBasics();
  });

  it("offers a first wheel the starter set, draws it, and reviews the cost from tomorrow", async () => {
    open();
    await pastBasics();
    next();
    fireEvent.click(await screen.findByRole("button", { name: W.starter.use }));
    expect(screen.getAllByText(K.prizes.slot)).toHaveLength(starterPrizes(LABELS).length);
    expect(screen.getByRole("img", { name: W.preview })).toBeInTheDocument();

    next();
    expect(screen.getAllByText(K.errors.amount).length).toBeGreaterThan(0);
    for (const box of screen.getAllByLabelText(label(K.prizes.cost))) if (!(box as HTMLInputElement).value) fireEvent.change(box, { target: { value: "500" } });
    next();
    expect(await screen.findByText(K.startsTomorrow)).toBeInTheDocument();
    expect(screen.getByText(K.cost.expected)).toBeInTheDocument();

    vi.mocked(wheelAdminApi.save).mockResolvedValue({} as never);
    fireEvent.click(screen.getByRole("button", { name: K.save }));
    await waitFor(() => expect(wheelAdminApi.save).toHaveBeenCalledTimes(1));
    expect(vi.mocked(wheelAdminApi.save).mock.calls[0][0].prizes).toHaveLength(starterPrizes(LABELS).length);
  });
});
