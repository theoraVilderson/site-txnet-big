import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PrizeServicePicker } from "./PrizeServicePicker";
import { useLocale } from "@/context/LocaleContext";
import { rewardTargetApi, type PrizeService, type RewardTarget } from "@/lib/billing/reward-target";
import { ApiError } from "@/lib/api-error";
import { notify } from "./kit/notify";
import { formatBytes } from "../services/_lib/service-configs";

/**
 * The prize-service picker (F-707-s) on the wheel and lotteries pages.
 *
 * What would break silently: a choice the page shows that billing does not
 * hold (the picker must redraw from billing's answer, and keep billing's
 * choice on a refusal); a service shown by an id or a key instead of its name;
 * the picker shown to a user with one service, where there is nothing to choose.
 */

vi.mock("@/context/LocaleContext", () => ({ useLocale: vi.fn() }));
vi.mock("@/lib/billing/reward-target", () => ({ rewardTargetApi: { view: vi.fn(), choose: vi.fn() } }));
vi.mock("../catalog/_lib/meter-names", () => ({ useCatalogTexts: () => ({ "catalog.p.gold": "Gold 50 GB" }) }));
vi.mock("./kit/notify", () => ({ notify: { success: vi.fn(), error: vi.fn() } }));

/** The key back, so an assertion names the string the component asked for. */
const t = (_ns: string, key: string, vars?: Record<string, string | number>) => (vars ? `${key}:${Object.values(vars).join(",")}` : key);

const svc = (id: string, o: Partial<PrizeService> = {}): PrizeService => ({
  id, label: null, variant: { id: `v-${id}`, sku: `SKU-${id}`, nameKey: "catalog.p.gold" }, endsAt: null, remainingBytes: null, takesTraffic: true, takesDays: true, ...o,
});
const view = vi.mocked(rewardTargetApi.view);
const choose = vi.mocked(rewardTargetApi.choose);
const target = (services: PrizeService[], chosenGrantId: string | null = null): RewardTarget => ({ services, chosenGrantId });

const TWO = [svc("a", { label: "Phone" }), svc("b", { takesTraffic: false })];
/** An option as the picker writes it: the name, then when it ends — and what is left, when capped (F-707-x). */
const opt = (name: string, left?: string) => (left ? `prizeService.optionWithLeft:${name},prizeService.noEnd,${left}` : `prizeService.option:${name},prizeService.noEnd`);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useLocale).mockReturnValue({ lang: "en", t } as never);
});

const button = () => screen.findByRole("button", { name: /prizeService.title/ });
async function pick(name: RegExp) {
  fireEvent.click(await button());
  fireEvent.click(screen.getByRole("option", { name }));
}

describe("PrizeServicePicker", () => {
  it("shows nothing when there is no choice to make", async () => {
    view.mockResolvedValue(target([svc("a")]));
    const { container } = render(<PrizeServicePicker />);
    await waitFor(() => expect(view).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("names each service as My services does, automatic first, with the choice billing holds", async () => {
    view.mockResolvedValue(target([svc("a", { label: "Phone", remainingBytes: String(6 * 1024 ** 3) }), svc("b", { takesTraffic: false }), svc("c", { variant: null })], "b"));
    render(<PrizeServicePicker />);
    expect(await button()).toHaveTextContent(opt("prizeService.daysOnly:Gold 50 GB"));
    fireEvent.click(await button());
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "prizeService.automatic",
      opt("Phone", formatBytes(String(6 * 1024 ** 3), "en") ?? ""),
      opt("prizeService.daysOnly:Gold 50 GB"),
      opt("myServices.unnamed"),
    ]);
  });

  it("saves a service by its id and automatic as null, and redraws from billing's answer", async () => {
    view.mockResolvedValue(target(TWO));
    choose.mockResolvedValueOnce(target(TWO, "a")).mockResolvedValueOnce(target(TWO));
    render(<PrizeServicePicker />);
    await pick(/Phone/);
    await waitFor(() => expect(choose).toHaveBeenCalledWith("a"));
    await waitFor(async () => expect(await button()).toHaveTextContent(opt("Phone")));
    expect(notify.success).toHaveBeenCalledWith("prizeService.saved");
    await pick(/prizeService.automatic/);
    await waitFor(() => expect(choose).toHaveBeenLastCalledWith(null));
  });

  it("keeps billing's choice and says why when the service is refused", async () => {
    view.mockResolvedValue(target(TWO, "a"));
    choose.mockRejectedValue(new ApiError("x", { status: 409, reason: "grant_not_eligible" }));
    render(<PrizeServicePicker />);
    await pick(/daysOnly/);
    await waitFor(() => expect(notify.error).toHaveBeenCalledWith("prizeService.refusals.grant_not_eligible"));
    expect(await button()).toHaveTextContent("Phone");
  });
});
