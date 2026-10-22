import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useLocale } from "@/context/LocaleContext";
import { aiApi, type SuggestionCard as Card } from "@/lib/ai-api";
import { billingApi, type GrantRow, type RenewalPlans, type ShopOffer } from "@/lib/billing-api";
import { NOTICE_KINDS } from "@/lib/notification-api";
import { panelShopVariantPath } from "@/lib/routes";
import { SuggestionCard } from "./_components/SuggestionCard";

vi.mock("./_components/RenewalSheet", () => ({
  RenewalSheet: ({ row, name, initialPlan }: { row: GrantRow; name: string; initialPlan?: string }) => (
    <div role="dialog">{`sheet:${row.id}:${name}:${initialPlan}`}</div>
  ),
}));

/**
 * F-038-h (ADR-0109 point 11): the user's current AI suggestion on My
 * services — one card, labelled, with **one** call to action (F-1507), a
 * close and a "don't show this again". The plan and its price are the shop's
 * today, never the engine's: a plan no longer for sale shows no card, as the
 * bot tells none (`plan_unavailable`). A pitch is never worth an error line,
 * so a failed read shows nothing.
 *
 * F-305-h: a `renew` leads to the renewal, never the shop — the shop sells a
 * new Grant. Its plan and price are that Grant's renewal plans (billing
 * `contract.renewal.md` "The plans the sheet lists"), and its call opens the
 * Grant's renewal sheet with the plan named already picked.
 */

vi.mock("@/context/LocaleContext", () => ({ useLocale: vi.fn() }));
vi.mock("@/lib/ai-api", () => ({ aiApi: { current: vi.fn(), dismiss: vi.fn(), optOut: vi.fn() } }));
vi.mock("@/lib/billing-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing-api")>()),
  billingApi: { shopOffers: vi.fn(), renewalPlans: vi.fn(), grants: vi.fn() },
}));

const t = (_ns: string, key: string, vars?: Record<string, string | number>) =>
  vars ? `${key}:${Object.values(vars).join(",")}` : key;

const offer = (variantId: string, nameKey: string, price: string): ShopOffer => ({
  variantId,
  sku: variantId.toUpperCase(),
  nameKey,
  productId: "p-1",
  productNameKey: "catalog.vpn",
  descriptionKey: null,
  categoryKey: "c",
  categories: [],
  fulfilmentKind: "network_access",
  durationDays: 30,
  billingMode: "prepaid",
  quotas: {},
  price,
  currencyCode: "USD",
  rateCards: [],
  remaining: null,
  soldOut: false,
});
const texts = { "catalog.small": "Small 50 GB", "catalog.big": "Big 100 GB" };
const card: Card = {
  actionId: "a-1",
  actionType: "resize_up",
  label: "suggestion",
  grantId: "g-1",
  variantId: "v-big",
  fromVariantId: "v-small",
  deadline: new Date(Date.now() + 3 * 86_400_000 - 60_000).toISOString(),
};

const ROW = { id: "g-1", label: null, status: "active", variant: { id: "v-small", sku: "V-SMALL", nameKey: "catalog.small" }, trafficUnlimited: false } as GrantRow;
const PLANS: RenewalPlans = {
  grantId: "g-1",
  ownPlanRenewable: true,
  plans: [
    { variantId: "v-small", sku: "V-SMALL", nameKey: "catalog.small", current: true, bytes: "1", days: 30, price: "4.50", currencyCode: "USD", campaignEndsAt: null },
    { variantId: "v-big", sku: "V-BIG", nameKey: "catalog.big", current: false, bytes: "2", days: 30, price: "8.00", currencyCode: "USD", campaignEndsAt: null },
  ],
  custom: null,
};
const renew: Card = { ...card, actionType: "renew", variantId: "v-small", fromVariantId: null };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useLocale).mockReturnValue({ lang: "en", t } as ReturnType<typeof useLocale>);
  vi.mocked(aiApi.current).mockResolvedValue({ suggestion: card });
  vi.mocked(aiApi.dismiss).mockResolvedValue({ dismissed: true });
  vi.mocked(aiApi.optOut).mockResolvedValue({ actionType: "resize_up" });
  vi.mocked(billingApi.shopOffers).mockResolvedValue([offer("v-small", "catalog.small", "5.00"), offer("v-big", "catalog.big", "8.00")]);
  vi.mocked(billingApi.renewalPlans).mockResolvedValue(PLANS);
  vi.mocked(billingApi.grants).mockResolvedValue({ rows: [ROW], page: 1, pageSize: 100, total: 1, hidden: 0 });
});

describe("the suggestion card (F-038-h)", () => {
  it("is one labelled card with one call to action: the shop opened on the plan it names, at today's price", async () => {
    const { container } = render(<SuggestionCard texts={texts} rows={[]} />);
    const cta = await screen.findByRole("link");
    expect(cta.getAttribute("href")).toBe(panelShopVariantPath("v-big"));
    expect(container.querySelectorAll("a")).toHaveLength(1);
    expect(screen.getByText("myServices.suggestion.label")).toBeTruthy();
    const body = screen.getByText(/^myServices\.suggestion\.resize_up\.body:/).textContent!;
    expect(body).toContain("Small 50 GB");
    expect(body).toContain("Big 100 GB");
    expect(body).toMatch(/8\.00/);
  });

  it("renew counts the days to its end", async () => {
    vi.mocked(aiApi.current).mockResolvedValue({ suggestion: renew });
    render(<SuggestionCard texts={texts} rows={[ROW]} />);
    expect((await screen.findByText(/^myServices\.suggestion\.renew\.body:/)).textContent).toContain(",3");
  });

  it.each([
    ["ai has no suggestion", () => vi.mocked(aiApi.current).mockResolvedValue({ suggestion: null })],
    ["ai cannot be read", () => vi.mocked(aiApi.current).mockRejectedValue(new Error("down"))],
    ["the plan is no longer sold", () => vi.mocked(billingApi.shopOffers).mockResolvedValue([offer("v-small", "catalog.small", "5.00")])],
    ["the shop cannot be read", () => vi.mocked(billingApi.shopOffers).mockRejectedValue(new Error("down"))],
  ])("shows nothing when %s", async (_why, arrange) => {
    arrange();
    const { container } = render(<SuggestionCard texts={texts} rows={[]} />);
    await waitFor(() => expect(aiApi.current).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(container.textContent).toBe("");
  });

  it("close dismisses this one; \"don't show this again\" opts out of the type; either way the card goes", async () => {
    for (const [name, call] of [
      ["myServices.suggestion.dismiss", aiApi.dismiss],
      ["myServices.suggestion.optOut", aiApi.optOut],
    ] as const) {
      const { container, unmount } = render(<SuggestionCard texts={texts} rows={[]} />);
      fireEvent.click(await screen.findByRole("button", { name }));
      await waitFor(() => expect(call).toHaveBeenCalledWith("a-1"));
      await waitFor(() => expect(container.textContent).toBe(""));
      unmount();
    }
  });

  it("a refused close keeps the card and says so", async () => {
    vi.mocked(aiApi.dismiss).mockRejectedValue(new Error("down"));
    render(<SuggestionCard texts={texts} rows={[]} />);
    fireEvent.click(await screen.findByRole("button", { name: "myServices.suggestion.dismiss" }));
    expect(await screen.findByText("myServices.suggestion.failed")).toBeTruthy();
    expect(screen.getByRole("link")).toBeTruthy();
  });
});

describe("renew leads to the renewal, not the shop (F-305-h)", () => {
  beforeEach(() => vi.mocked(aiApi.current).mockResolvedValue({ suggestion: renew }));

  it("prices the plan as this Grant's renewal and reads no shop", async () => {
    render(<SuggestionCard texts={texts} rows={[ROW]} />);
    const body = (await screen.findByText(/^myServices\.suggestion\.renew\.body:/)).textContent!;
    expect(billingApi.renewalPlans).toHaveBeenCalledWith("g-1");
    expect(billingApi.shopOffers).not.toHaveBeenCalled();
    expect(body).toContain("Small 50 GB");
    expect(body).toMatch(/4\.50/);
  });

  it("its one call is a button, no link, that opens the Grant's renewal sheet with the plan picked", async () => {
    const { container } = render(<SuggestionCard texts={texts} rows={[ROW]} />);
    fireEvent.click(await screen.findByRole("button", { name: /^myServices\.suggestion\.renew\.cta/ }));
    expect((await screen.findByRole("dialog")).textContent).toBe("sheet:g-1:Small 50 GB:v-small");
    expect(container.querySelectorAll("a")).toHaveLength(0);
    expect(billingApi.grants).not.toHaveBeenCalled();
  });

  it("a Grant not on the page shown is read from the list before the sheet opens", async () => {
    render(<SuggestionCard texts={texts} rows={[]} />);
    fireEvent.click(await screen.findByRole("button", { name: /^myServices\.suggestion\.renew\.cta/ }));
    expect((await screen.findByRole("dialog")).textContent).toBe("sheet:g-1:Small 50 GB:v-small");
    expect(billingApi.grants).toHaveBeenCalledWith(1, 100, "current");
  });

  it("a Grant the list no longer holds opens nothing and says so", async () => {
    vi.mocked(billingApi.grants).mockResolvedValue({ rows: [], page: 1, pageSize: 100, total: 0, hidden: 0 });
    render(<SuggestionCard texts={texts} rows={[]} />);
    fireEvent.click(await screen.findByRole("button", { name: /^myServices\.suggestion\.renew\.cta/ }));
    expect(await screen.findByText("myServices.suggestion.failed")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it.each([
    ["the plan is not one this Grant renews to", () => vi.mocked(billingApi.renewalPlans).mockResolvedValue({ ...PLANS, plans: [PLANS.plans[1]] })],
    ["billing refuses the Grant", () => vi.mocked(billingApi.renewalPlans).mockRejectedValue(new Error("409"))],
  ])("shows nothing when %s", async (_why, arrange) => {
    arrange();
    const { container } = render(<SuggestionCard texts={texts} rows={[ROW]} />);
    await waitFor(() => expect(billingApi.renewalPlans).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(container.textContent).toBe("");
  });
});

describe("the notice settings' kinds (F-038-h)", () => {
  it("are shared-core's RETENTION_MUTABLE_KINDS, in order — `suggestion` included, so a save never drops its mute", () => {
    const file = readFileSync(join(__dirname, "../../../../../txnet-backend/shared-core/src/lib/automation/retention-kinds.ts"), "utf8");
    const block = /RETENTION_MUTABLE_KINDS = \[([^\]]*)\]/.exec(file);
    if (!block) throw new Error("RETENTION_MUTABLE_KINDS moved — this test is stale");
    expect([...NOTICE_KINDS]).toEqual([...block[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
  });
});
