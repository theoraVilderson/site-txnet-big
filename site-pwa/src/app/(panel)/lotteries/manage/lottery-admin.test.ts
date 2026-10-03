import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { Me } from "@/lib/auth-api";
import type { AdminLottery } from "@/lib/engagement-api";
import { PANEL_LOTTERIES_MANAGE } from "@/lib/routes";
import { PANEL_MENU, menuHrefs, visibleMenu } from "../../_lib/panel-menu";
import {
  CLOSE_MAX_DAYS,
  CLOSE_MIN_HOURS,
  DESCRIPTION_MAX,
  LOTTERY_ADMIN_KEYS,
  LOTTERY_MANAGE,
  LOTTERY_PRIZE_TYPES,
  PRIZES_MAX,
  PRIZE_LABEL_MAX,
  REASON_MAX,
  REFUSAL_KEYS,
  RESERVES_MAX,
  TITLE_MAX,
  WINNERS_MAX,
  actionsFor,
  adminStatusKey,
  canManageLotteries,
  emptyLotteryForm,
  emptyLotteryPrize,
  instantToWallClock,
  lotteryDraftBody,
  lotteryFormFrom,
  validateLotteryForm,
  wallClockToInstant,
  type LotteryForm,
} from "./_lib/lottery-admin";

/**
 * The admin's lotteries (F-707-o), over billing's
 * `/api/billing/engagement/lotteries` (F-707-i) and its two reads (F-707-o).
 * What breaks with nothing red anywhere:
 *  - **a close time in the wrong zone** — the admin types a wall clock in
 *    their resolved zone (TZ-1-e); sent as the browser's, a Tehran admin's
 *    lottery closes three and a half hours off;
 *  - **an act offered that billing refuses for the status** — after publish
 *    only cancel (point 5), after the freeze nothing;
 *  - **a body the `.strict()` schema refuses**, a prize kind billing never
 *    takes (cash, empty), or a refusal with no sentence.
 */
const REPO = join(__dirname, "../../../../../..");
const LOCALES = join(REPO, "locales/frontend/langs");
const ENGAGEMENT = join(REPO, "txnet-backend/billing-service/src/app/engagement");
const read = (file: string) => readFileSync(join(ENGAGEMENT, file), "utf8");

const ADMIN: Me = {
  userId: "u1",
  fullName: "Theora",
  role: { id: "r1", name: "Admin" },
  permissions: ["engagement.manage"],
  tenant: { id: "t-res", type: "reseller", isOwner: false },
  email: null,
  isImpersonated: false,
};
const SUPPORT: Me = { ...ADMIN, role: { id: "r2", name: "Support" }, permissions: ["user.search"] };
const GROUP = "66666666-6666-4666-8666-666666666666";
const TEMPLATE = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-03T12:00:00Z");
const TEHRAN = "Asia/Tehran";

const form = (over: Partial<LotteryForm> = {}): LotteryForm => ({
  ...emptyLotteryForm(),
  userGroupId: GROUP,
  title: "October draw",
  closesAt: "2026-10-10T20:00",
  prizes: [{ ...emptyLotteryPrize(), label: "50 GB", prizeType: "bonus_traffic_gb", prizeValue: "50", winnersCount: "1" }],
  ...over,
});

describe("what billing can refuse this page with", () => {
  it("has a sentence for every reason", () => {
    const union = /export type LotteryAdminRejection =([\s\S]*?);/.exec(read("lottery-admin.service.ts"));
    if (!union) throw new Error("LotteryAdminRejection is no longer a literal union — this test is stale");
    const reasons = [...union[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(Object.keys(REFUSAL_KEYS).sort()).toEqual(reasons.sort());
  });

  it("gates on the guard's own key and holds the schema's and the service's bounds", () => {
    expect(read("engagement-permission.guard.ts")).toContain(`ENGAGEMENT_MANAGE = '${LOTTERY_MANAGE}'`);
    const schema = read("lottery-admin.schema.ts");
    expect(schema).toContain(`prizes: z.array(prizeSchema).min(1).max(${PRIZES_MAX})`);
    expect(schema).toContain(`label: z.string().trim().min(1).max(${PRIZE_LABEL_MAX})`);
    expect(schema).toContain(`title: z.string().trim().min(1).max(${TITLE_MAX})`);
    expect(schema).toContain(`.max(${DESCRIPTION_MAX})`);
    expect(schema).toContain(`winnersCount: z.number().int().min(1).max(${WINNERS_MAX})`);
    expect(schema).toContain(`reservesCount: z.number().int().min(0).max(${RESERVES_MAX})`);
    expect(schema).toContain(`reason: z.string().trim().min(1).max(${REASON_MAX})`);
    const service = read("lottery-admin.service.ts");
    expect(service).toContain(`LOTTERY_MIN_OPEN_MS = ${CLOSE_MIN_HOURS === 1 ? "" : `${CLOSE_MIN_HOURS} * `}60 * 60 * 1000`);
    expect(service).toContain(`LOTTERY_MAX_OPEN_MS = ${CLOSE_MAX_DAYS} * 24 * 60 * 60 * 1000`);
  });

  it("never offers cash or an empty prize (ADR-0111 point 2)", () => {
    expect(LOTTERY_PRIZE_TYPES).not.toContain("wallet_credit");
    expect(LOTTERY_PRIZE_TYPES).not.toContain("empty");
    expect([...LOTTERY_PRIZE_TYPES].sort()).toEqual(["bonus_traffic_gb", "discount_coupon", "extra_days", "free_grant"]);
  });
});

describe("who sees the page", () => {
  const hrefs = (me: Me) => menuHrefs(visibleMenu(PANEL_MENU, me.permissions, me.tenant.type, me.tenant.isOwner));
  it("is anyone holding engagement.manage, in any tenant", () => {
    expect(canManageLotteries(ADMIN)).toBe(true);
    expect(canManageLotteries(SUPPORT)).toBe(false);
    expect(canManageLotteries(null)).toBe(false);
    expect(hrefs(ADMIN)).toContain(PANEL_LOTTERIES_MANAGE);
    expect(hrefs(SUPPORT)).not.toContain(PANEL_LOTTERIES_MANAGE);
  });
});

describe("the close time is the admin's wall clock, in their resolved zone", () => {
  it("turns a Tehran wall clock into its instant, and back", () => {
    expect(wallClockToInstant("2026-10-10T20:00", TEHRAN)).toBe("2026-10-10T16:30:00.000Z");
    expect(instantToWallClock("2026-10-10T16:30:00.000Z", TEHRAN)).toBe("2026-10-10T20:00");
    expect(wallClockToInstant("2026-10-10T20:00", "UTC")).toBe("2026-10-10T20:00:00.000Z");
  });

  it("answers null for what is not a wall clock", () => {
    expect(wallClockToInstant("", TEHRAN)).toBeNull();
    expect(wallClockToInstant("10/10/2026 20:00", TEHRAN)).toBeNull();
  });
});

describe("the form", () => {
  it("passes a lottery billing would take", () => {
    expect(validateLotteryForm(form(), TEHRAN, NOW).ok).toBe(true);
  });

  it("asks for a group, a title and a close time inside billing's window", () => {
    const c = validateLotteryForm(form({ userGroupId: "", title: "  ", closesAt: "2026-10-03T15:00" }), TEHRAN, NOW);
    expect(c.ok).toBe(false);
    // 15:00 Tehran is 11:30Z: already past.
    expect(c.fields).toMatchObject({ userGroupId: LOTTERY_ADMIN_KEYS.errors.groupRequired, title: LOTTERY_ADMIN_KEYS.errors.titleRequired, closesAt: LOTTERY_ADMIN_KEYS.errors.closeTooSoon });
    expect(validateLotteryForm(form({ closesAt: "2026-10-03T16:00" }), TEHRAN, NOW).fields.closesAt).toBe(LOTTERY_ADMIN_KEYS.errors.closeTooSoon);
    expect(validateLotteryForm(form({ closesAt: "2026-10-03T16:30" }), TEHRAN, NOW).fields.closesAt).toBeUndefined();
    expect(validateLotteryForm(form({ closesAt: "2027-04-02T20:00" }), TEHRAN, NOW).fields.closesAt).toBe(LOTTERY_ADMIN_KEYS.errors.closeTooFar);
  });

  it("holds each kind to its own shape, and every prize to at least one winner", () => {
    const c = validateLotteryForm(
      form({
        prizes: [
          { ...emptyLotteryPrize(), label: "d", prizeType: "extra_days", prizeValue: "1.5", winnersCount: "1" },
          { ...emptyLotteryPrize(), label: "c", prizeType: "discount_coupon", prizeValue: "20", couponTemplateId: "", couponValidDays: "", winnersCount: "0" },
          { ...emptyLotteryPrize(), label: "g", prizeType: "free_grant", variantId: "", winnersCount: "1" },
        ],
      }),
      TEHRAN,
      NOW,
    );
    expect(c.prizes[0]).toEqual({ prizeValue: LOTTERY_ADMIN_KEYS.errors.wholeDays });
    expect(c.prizes[1]).toEqual({ couponTemplateId: LOTTERY_ADMIN_KEYS.errors.templateRequired, couponValidDays: LOTTERY_ADMIN_KEYS.errors.validDays, winnersCount: LOTTERY_ADMIN_KEYS.errors.winners });
    expect(c.prizes[2]).toEqual({ variantId: LOTTERY_ADMIN_KEYS.errors.variantRequired });
  });

  it("counts the prizes and the reserves", () => {
    expect(validateLotteryForm(form({ prizes: [] }), TEHRAN, NOW).overall).toBe(LOTTERY_ADMIN_KEYS.errors.noPrizes);
    expect(validateLotteryForm(form({ reservesCount: "101" }), TEHRAN, NOW).fields.reservesCount).toBe(LOTTERY_ADMIN_KEYS.errors.reserves);
  });

  it("sends the schema's keys only, the close as an instant, each prize with its kind's fields and no other", () => {
    const body = lotteryDraftBody(
      form({
        description: "  ",
        entryMode: "opt_in",
        prizes: [
          { ...emptyLotteryPrize(), label: " 20% ", prizeType: "discount_coupon", prizeValue: "20", couponTemplateId: TEMPLATE, couponValidDays: "14", variantId: "stale", winnersCount: "5" },
          { ...emptyLotteryPrize(), label: "Grant", prizeType: "free_grant", prizeValue: "9", couponTemplateId: TEMPLATE, variantId: "v1", winnersCount: "1" },
        ],
      }),
      TEHRAN,
    );
    const schemaKeys = [...read("lottery-admin.schema.ts").matchAll(/^\s{4}([a-zA-Z]+):/gm)].map((m) => m[1]);
    for (const k of Object.keys(body)) expect(schemaKeys).toContain(k);
    for (const k of Object.keys(body.prizes[0])) expect(schemaKeys).toContain(k);
    expect(body).toMatchObject({ userGroupId: GROUP, title: "October draw", description: null, entryMode: "opt_in", closesAt: "2026-10-10T16:30:00.000Z", requiresPhoneVerified: true, requiresMinAccountAgeHours: 24, reservesCount: 0 });
    expect(body.prizes).toEqual([
      { label: "20%", prizeType: "discount_coupon", prizeValue: "20", couponTemplateId: TEMPLATE, couponValidDays: 14, variantId: null, winnersCount: 5 },
      { label: "Grant", prizeType: "free_grant", prizeValue: "0", couponTemplateId: null, couponValidDays: null, variantId: "v1", winnersCount: 1 },
    ]);
  });

  it("opens on the draft it edits, so a save restates what is not changed", () => {
    const l = lottery("draft", {
      description: "For members",
      reservesCount: 3,
      requiresPhoneVerified: false,
      prizes: [
        { id: "p2", rank: 2, label: "b", prizeType: "extra_days", prizeValue: "7.00", couponTemplateId: null, couponValidDays: null, variantId: null, winnersCount: 3 },
        { id: "p1", rank: 1, label: "a", prizeType: "bonus_traffic_gb", prizeValue: "10.00", couponTemplateId: null, couponValidDays: null, variantId: null, winnersCount: 1 },
      ],
    });
    const f = lotteryFormFrom(l, TEHRAN);
    expect(f).toMatchObject({ title: "Stored", description: "For members", reservesCount: "3", requiresPhoneVerified: false, closesAt: "2026-10-10T20:00" });
    expect(lotteryDraftBody(f, TEHRAN).prizes.map((p) => [p.label, p.prizeValue, p.winnersCount])).toEqual([
      ["a", "10.00", 1],
      ["b", "7.00", 3],
    ]);
  });
});

function lottery(status: AdminLottery["status"], over: Partial<AdminLottery> = {}): AdminLottery {
  return {
    id: "lot-1",
    status,
    userGroupId: GROUP,
    title: "Stored",
    description: null,
    entryMode: "automatic",
    closesAt: "2026-10-10T16:30:00.000Z",
    requiresPhoneVerified: true,
    requiresMinAccountAgeHours: 24,
    reservesCount: 0,
    publishedAt: status === "draft" ? null : "2026-10-03T12:00:00.000Z",
    cancelledAt: null,
    cancelReason: null,
    createdByAdminId: "u1",
    createdAt: "2026-10-03T11:00:00.000Z",
    entrantCount: 0,
    winnersTotal: 1,
    prizes: [],
    ...over,
  };
}

describe("what each status allows", () => {
  it("is billing's: a draft is edited, deleted or published; an open one only cancelled; after the freeze nothing", () => {
    expect(actionsFor("draft")).toEqual({ edit: true, remove: true, publish: true, cancel: true });
    expect(actionsFor("published")).toEqual({ edit: false, remove: false, publish: false, cancel: true });
    for (const s of ["frozen", "drawn", "cancelled"] as const) expect(actionsFor(s)).toEqual({ edit: false, remove: false, publish: false, cancel: false });
  });

  it("reads an open lottery past its close as closing, until the next minute's freeze", () => {
    expect(adminStatusKey(lottery("published"), NOW)).toBe(LOTTERY_ADMIN_KEYS.status.open);
    expect(adminStatusKey(lottery("published"), new Date("2026-10-11T00:00:00Z"))).toBe(LOTTERY_ADMIN_KEYS.status.closing);
    expect(adminStatusKey(lottery("drawn"), NOW)).toBe(LOTTERY_ADMIN_KEYS.status.drawn);
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
    expect(flatten(LOTTERY_ADMIN_KEYS).filter((k) => !keys.has(k))).toEqual([]);
  });
});
