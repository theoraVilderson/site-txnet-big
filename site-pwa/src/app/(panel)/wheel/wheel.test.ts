import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { Me } from "@/lib/auth-api";
import type { SpinResult } from "@/lib/engagement-api";
import { PANEL_WHEEL } from "@/lib/routes";
import { PANEL_MENU, menuHrefs, visibleMenu } from "../_lib/panel-menu";
import { REFUSAL_KEYS, WHEEL_KEYS, landingRotation, nextRequestId, resultLine, slotUnderPointer } from "./_lib/wheel";

/**
 * The user's wheel (F-707-g, ADR-0111 point 4), over billing's `/api/billing/wheel`.
 * What breaks with nothing red anywhere:
 *  - **the client deciding** — the wheel stops on the slot billing named, and
 *    nothing under `wheel/` draws a random number;
 *  - **a retried tap spinning twice** — a lost answer keeps the tap's
 *    `requestId`, so billing answers the same spin; an answer ends it;
 *  - **a refusal with no sentence** — every reason billing gives has one.
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

describe("what billing can answer this page with", () => {
  it("has a sentence for every refusal, recorded or not", () => {
    const src = readFileSync(join(ENGAGEMENT, "wheel-spin.service.ts"), "utf8");
    const reasons = [/export type SpinRefusalReason =([\s\S]*?);/, /export type WheelSpinRejection =([\s\S]*?);/].flatMap((re) => {
      const m = re.exec(src);
      if (!m) throw new Error("a rejection is no longer a literal union — this test is stale");
      return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
    });
    expect(Object.keys(REFUSAL_KEYS).sort()).toEqual(reasons.sort());
  });
});

describe("who sees the page", () => {
  it("is every signed-in user: billing says whether they may spin", () => {
    expect(menuHrefs(visibleMenu(PANEL_MENU, USER.permissions, USER.tenant.type, USER.tenant.isOwner))).toContain(PANEL_WHEEL);
  });
});

describe("the wheel stops where billing said", () => {
  it.each([2, 5, 8, 16])("lands every one of %i slots under the pointer, from any start", (count) => {
    for (const from of [0, 37, 359, 1234.5]) {
      for (let position = 1; position <= count; position++) {
        const to = landingRotation(from, position, count);
        expect(slotUnderPointer(to, count)).toBe(position);
        expect(to - from).toBeGreaterThanOrEqual(360 * 4);
      }
    }
  });

  it("draws no random number anywhere under wheel/", () => {
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => {
        const p = join(dir, f);
        return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) && !/\.test\./.test(f) ? [p] : [];
      });
    for (const f of files(__dirname)) expect(readFileSync(f, "utf8"), f).not.toMatch(/Math\.random|getRandomValues/);
  });
});

describe("one tap, one spin", () => {
  it("keeps the key after a lost answer, and starts a new one after any answer", () => {
    expect(nextRequestId("k-1", "lost")).toBe("k-1");
    expect(nextRequestId("k-1", "answered")).not.toBe("k-1");
  });
});

describe("what the user is told", () => {
  const result = (over: Partial<SpinResult>): SpinResult => ({
    attemptId: "a",
    status: "awarded",
    refusalReason: null,
    version: 1,
    tenantDay: "2026-10-03",
    seq: 1,
    position: 1,
    prize: null,
    reward: null,
    replay: false,
    ...over,
  });

  it("names the prize by its kind, a refusal by its reason, and nothing as nothing", () => {
    expect(resultLine(result({ prize: { position: 1, label: "1 GB", prizeType: "bonus_traffic_gb", prizeValue: "1.50" } }))).toEqual({
      key: WHEEL_KEYS.result.bonus_traffic_gb,
      values: { value: "1.5", label: "1 GB" },
    });
    expect(resultLine(result({ prize: { position: 2, label: "3 days", prizeType: "extra_days", prizeValue: "3.00" } }))).toEqual({
      key: WHEEL_KEYS.result.extra_days,
      values: { value: "3", label: "3 days" },
    });
    expect(resultLine(result({ position: 3 }))).toEqual({ key: WHEEL_KEYS.result.empty, values: {} });
    expect(resultLine(result({ status: "rejected_ineligible", refusalReason: "cooldown", position: null, seq: null }))).toEqual({
      key: WHEEL_KEYS.result.refused,
      values: {},
      reason: REFUSAL_KEYS.cooldown,
    });
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
    expect(flatten(WHEEL_KEYS).filter((k) => !keys.has(k))).toEqual([]);
  });
});
