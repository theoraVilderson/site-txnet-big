import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useLocale } from "@/context/LocaleContext";
import { aiApi, type SuggestionCard as Card } from "@/lib/ai-api";
import { billingApi, type ShopOffer } from "@/lib/billing-api";
import { NOTICE_KINDS } from "@/lib/notification-api";
import { panelShopVariantPath } from "@/lib/routes";
import { SuggestionCard } from "./_components/SuggestionCard";

/**
 * F-038-h (ADR-0109 point 11): the user's current AI suggestion on My
 * services — one card, labelled, with **one** call to action (F-1507), a
 * close and a "don't show this again". The plan and its price are the shop's
 * today, never the engine's: a plan no longer for sale shows no card, as the
 * bot tells none (`plan_unavailable`). A pitch is never worth an error line,
 * so a failed read shows nothing.
 */

vi.mock("@/context/LocaleContext", () => ({ useLocale: vi.fn() }));
vi.mock("@/lib/ai-api", () => ({ aiApi: { current: vi.fn(), dismiss: vi.fn(), optOut: vi.fn() } }));
vi.mock("@/lib/billing-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing-api")>()),
  billingApi: { shopOffers: vi.fn() },
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useLocale).mockReturnValue({ lang: "en", t } as ReturnType<typeof useLocale>);
  vi.mocked(aiApi.current).mockResolvedValue({ suggestion: card });
  vi.mocked(aiApi.dismiss).mockResolvedValue({ dismissed: true });
  vi.mocked(aiApi.optOut).mockResolvedValue({ actionType: "resize_up" });
  vi.mocked(billingApi.shopOffers).mockResolvedValue([offer("v-small", "catalog.small", "5.00"), offer("v-big", "catalog.big", "8.00")]);
});

describe("the suggestion card (F-038-h)", () => {
  it("is one labelled card with one call to action: the shop opened on the plan it names, at today's price", async () => {
    const { container } = render(<SuggestionCard texts={texts} />);
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
    vi.mocked(aiApi.current).mockResolvedValue({ suggestion: { ...card, actionType: "renew", variantId: "v-small" } });
    render(<SuggestionCard texts={texts} />);
    expect((await screen.findByText(/^myServices\.suggestion\.renew\.body:/)).textContent).toContain(",3");
  });

  it.each([
    ["ai has no suggestion", () => vi.mocked(aiApi.current).mockResolvedValue({ suggestion: null })],
    ["ai cannot be read", () => vi.mocked(aiApi.current).mockRejectedValue(new Error("down"))],
    ["the plan is no longer sold", () => vi.mocked(billingApi.shopOffers).mockResolvedValue([offer("v-small", "catalog.small", "5.00")])],
    ["the shop cannot be read", () => vi.mocked(billingApi.shopOffers).mockRejectedValue(new Error("down"))],
  ])("shows nothing when %s", async (_why, arrange) => {
    arrange();
    const { container } = render(<SuggestionCard texts={texts} />);
    await waitFor(() => expect(aiApi.current).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(container.textContent).toBe("");
  });

  it("close dismisses this one; \"don't show this again\" opts out of the type; either way the card goes", async () => {
    for (const [name, call] of [
      ["myServices.suggestion.dismiss", aiApi.dismiss],
      ["myServices.suggestion.optOut", aiApi.optOut],
    ] as const) {
      const { container, unmount } = render(<SuggestionCard texts={texts} />);
      fireEvent.click(await screen.findByRole("button", { name }));
      await waitFor(() => expect(call).toHaveBeenCalledWith("a-1"));
      await waitFor(() => expect(container.textContent).toBe(""));
      unmount();
    }
  });

  it("a refused close keeps the card and says so", async () => {
    vi.mocked(aiApi.dismiss).mockRejectedValue(new Error("down"));
    render(<SuggestionCard texts={texts} />);
    fireEvent.click(await screen.findByRole("button", { name: "myServices.suggestion.dismiss" }));
    expect(await screen.findByText("myServices.suggestion.failed")).toBeTruthy();
    expect(screen.getByRole("link")).toBeTruthy();
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
