import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { Me } from "@/lib/auth-api";
import type { LotteryResult, UserLottery } from "@/lib/engagement-api";
import { lotteryListHash, lotteryPlaces } from "@/lib/lottery-draw";
import { PANEL_LOTTERIES } from "@/lib/routes";
import { PANEL_MENU, menuHrefs, visibleMenu } from "../_lib/panel-menu";
import { EXCLUDED_KEYS, LOTTERY_KEYS, REFUSAL_KEYS, entryState, statusKey, verifyDraw } from "./_lib/lotteries";

/**
 * The user's lotteries (F-707-n, ADR-0111 point 5), over billing's
 * `/api/billing/lotteries`. What breaks with nothing red anywhere:
 *  - **a verify step that is not the draw** — the page runs a copy of
 *    shared-core's `lottery-draw.ts`; the copy must be byte for byte the same
 *    file, or the browser checks a different algorithm from the one drawn;
 *  - **a check that passes whatever was published** — a changed ticket, a
 *    swapped place or a different seed must each fail it;
 *  - **a reason with no sentence** — every exclusion and refusal billing gives
 *    has one.
 */
const REPO = join(__dirname, "../../../../..");
const LOCALES = join(REPO, "locales/frontend/langs");
const ENGAGEMENT = join(REPO, "txnet-backend/billing-service/src/app/engagement");

const USER: Me = {
  userId: "u1",
  fullName: "Theora",
  role: { id: "r1", name: "User" },
  permissions: [],
  tenant: { id: "t-res", type: "reseller", isOwner: false },
  email: null,
  isImpersonated: false,
};

describe("the draw this page checks is the draw billing made", () => {
  it("is shared-core's lottery-draw.ts, byte for byte", () => {
    const shared = readFileSync(join(REPO, "txnet-backend/shared-core/src/lib/engagement/lottery-draw.ts"), "utf8");
    const here = readFileSync(join(REPO, "site-pwa/src/lib/lottery-draw.ts"), "utf8");
    expect(here).toBe(shared);
  });
});

const LOT = "aaaaaaaa-0000-4000-8000-0000000000a1";
const SEED = "ab".repeat(32);

/** A result as billing publishes it, made with the algorithm itself. */
async function published(): Promise<LotteryResult> {
  const tickets = Array.from({ length: 8 }, (_, i) => ({ ticketNumber: i + 1, entrantId: `e-${i + 1}` }));
  const listHash = await lotteryListHash(LOT, tickets);
  const prizes = [
    { rank: 1, label: "20 GB", winnersCount: 1 },
    { rank: 2, label: "10% off", winnersCount: 2 },
  ];
  const places = await lotteryPlaces({ seed: SEED, listHash, entrantCount: 8, prizes, reservesCount: 2 });
  const label = (rank: number | null) => prizes.find((p) => p.rank === rank)?.label ?? "";
  return {
    lotteryId: LOT,
    title: "Autumn draw",
    algorithm: "hmac-sha256-fisher-yates-v1",
    seed: SEED,
    listHash,
    entrantCount: 8,
    prizes,
    reservesCount: 2,
    frozenAt: "2026-10-10T12:00:00Z",
    drawnAt: "2026-10-10T12:01:00Z",
    tickets,
    places: places.map((p) => ({
      position: p.position,
      ticketNumber: p.ticketNumber,
      prize: p.prizeRank === null ? null : { rank: p.prizeRank, label: label(p.prizeRank) },
      delivery: "delivered",
      passedOnReason: null,
      replacesPosition: null,
    })),
    mine: null,
  };
}

describe("checking the draw in the browser", () => {
  it("passes what billing published", async () => {
    expect(await verifyDraw(await published())).toEqual({ outcome: "ok", positions: [] });
  });

  it("passes a prize passed on to a reserve, which names the place it took over", async () => {
    const r = await published();
    r.places[0] = { ...r.places[0], delivery: "passed_on", passedOnReason: "inactive" };
    r.places[3] = { ...r.places[3], prize: r.places[0].prize, replacesPosition: 1 };
    expect(await verifyDraw(r)).toEqual({ outcome: "ok", positions: [] });
  });

  it("fails a ticket list that is not the one hashed", async () => {
    const r = await published();
    r.tickets[2] = { ticketNumber: 3, entrantId: "e-x" };
    expect((await verifyDraw(r)).outcome).toBe("list_mismatch");
  });

  it("fails swapped places, naming them", async () => {
    const r = await published();
    [r.places[0].ticketNumber, r.places[1].ticketNumber] = [r.places[1].ticketNumber, r.places[0].ticketNumber];
    expect(await verifyDraw(r)).toEqual({ outcome: "places_mismatch", positions: [1, 2] });
  });

  it("fails a prize moved to a reserve with no place it took over", async () => {
    const r = await published();
    r.places[4] = { ...r.places[4], prize: { rank: 1, label: "20 GB" } };
    expect(await verifyDraw(r)).toEqual({ outcome: "places_mismatch", positions: [5] });
  });

  it("fails another seed", async () => {
    const r = await published();
    expect((await verifyDraw({ ...r, seed: "ac".repeat(32) })).outcome).toBe("places_mismatch");
  });

  it("does not claim to check a method it does not know", async () => {
    expect((await verifyDraw({ ...(await published()), algorithm: "something-v2" })).outcome).toBe("unknown_algorithm");
  });
});

describe("what the user is told", () => {
  const lottery = (over: Partial<UserLottery>): UserLottery => ({
    id: LOT,
    title: "Autumn draw",
    description: null,
    entryMode: "opt_in",
    status: "published",
    closesAt: "2026-10-10T12:00:00Z",
    publishedAt: "2026-10-01T12:00:00Z",
    cancelReason: null,
    open: true,
    prizes: [],
    entry: null,
    ...over,
  });

  it("names the status, a published lottery past its close as closing", () => {
    expect(statusKey(lottery({}))).toBe(LOTTERY_KEYS.status.open);
    expect(statusKey(lottery({ open: false }))).toBe(LOTTERY_KEYS.status.closing);
    expect(statusKey(lottery({ status: "drawn", open: false }))).toBe(LOTTERY_KEYS.status.drawn);
  });

  it("offers a join or a leave only on an open opt-in lottery", () => {
    expect(entryState(lottery({}))).toBe("can_join");
    expect(entryState(lottery({ entry: { optedInAt: "2026-10-02T00:00:00Z", ticketNumber: null, excludedReason: null } }))).toBe("can_leave");
    expect(entryState(lottery({ entryMode: "automatic" }))).toBe("automatic");
    expect(entryState(lottery({ open: false, status: "frozen", entry: { optedInAt: null, ticketNumber: 4, excludedReason: null } }))).toBe("ticket");
    expect(entryState(lottery({ open: false, status: "frozen", entry: { optedInAt: null, ticketNumber: null, excludedReason: "flagged" } }))).toBe("excluded");
    expect(entryState(lottery({ open: false, status: "frozen" }))).toBe("none");
  });

  const union = (file: string, re: RegExp) => {
    const m = re.exec(readFileSync(join(ENGAGEMENT, file), "utf8"));
    if (!m) throw new Error(`${file}: the union is no longer a literal — this test is stale`);
    return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
  };

  it("has a sentence for every reason the close excludes someone", () => {
    expect(Object.keys(EXCLUDED_KEYS).sort()).toEqual(union("lottery-close.service.ts", /export type ExclusionReason =([^;]*);/));
  });

  it("has a sentence for every refusal of the entry and result routes", () => {
    expect(Object.keys(REFUSAL_KEYS).sort()).toEqual(union("lottery-entry.service.ts", /export type LotteryEntryRejection =([^;]*);/));
  });

  it("has a sentence for every reason a prize passes on", () => {
    expect(Object.keys(LOTTERY_KEYS.result.passedOn).sort()).toEqual(union("lottery-delivery.service.ts", /export type PassedOnReason =([^;]*);/));
  });
});

describe("who sees the page", () => {
  it("is every signed-in user: billing shows each the lotteries of its groups", () => {
    expect(menuHrefs(visibleMenu(PANEL_MENU, USER.permissions, USER.tenant.type, USER.tenant.isOwner))).toContain(PANEL_LOTTERIES);
  });
});

describe("every key this page can reach", () => {
  const flatten = (v: unknown): string[] => (typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(flatten) : []);
  const shipped = (lang: string) => {
    const out = new Set<string>();
    const walk = (prefix: string, value: unknown) => {
      if (value && typeof value === "object") for (const [k, c] of Object.entries(value)) walk(prefix ? `${prefix}.${k}` : k, c);
      else if (typeof value === "string") out.add(prefix);
    };
    walk("", JSON.parse(readFileSync(join(LOCALES, lang, "common.json"), "utf8")));
    return out;
  };
  it.each(["en", "fa"])("resolves in %s", (lang) => {
    const keys = shipped(lang);
    expect(flatten(LOTTERY_KEYS).filter((k) => !keys.has(k))).toEqual([]);
  });
});
