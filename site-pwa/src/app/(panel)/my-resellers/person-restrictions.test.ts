import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { personRestrictionsPath, type PersonRestrictions, type RestrictionKeyView } from "@/lib/auth-api";
import { instantOf } from "../_lib/datetime";
import { RESTRICTION_REFUSAL_KEYS, draftOf, restrictionDraftOk, restrictionWriteBody, unsetKeys } from "./_lib/person-restrictions";

/**
 * The Restrictions section of a user's Profile tab (F-030-f) over
 * `GET`/`PUT`/`DELETE …/users/:userId/restrictions` (F-030-d). What breaks
 * here with nothing red on the server:
 *
 *  - **a value sent in the wrong shape** — a count typed as text goes as a
 *    string, or a set goes empty — and the route answers
 *    `restriction_value_invalid` to a form that looked fine;
 *  - **Save offered for what the route refuses**: a count past the key's
 *    `max`, a fraction, an expiry already past;
 *  - **a key offered twice** — "add" lists a key already set, which is a
 *    change, not a new restriction;
 *  - **a refusal with no sentence**, read out of the service's own union.
 */
const REPO = join(__dirname, "../../../../..");
const SERVICE = "txnet-backend/auth-service/src/app/governance/user-restrictions/user-restrictions.service.ts";

const KEYS: RestrictionKeyView[] = [
  { key: "services_active_max", kind: "count", max: 10_000 },
  { key: "configs_max", kind: "count", max: 100_000 },
  { key: "topup_categories_barred", kind: "set", options: ["crypto", "domestic_rial", "in_chat", "international_card"] },
];
const [SERVICES, , TOPUP] = KEYS;

const view = (over: Partial<PersonRestrictions> = {}): PersonRestrictions => ({
  userId: "u-buyer",
  restrictions: [{ key: "services_active_max", value: 3, reason: "chargeback last month", by: "u-lead", at: "2026-10-01T00:00:00Z", expiresAt: null }],
  keys: KEYS,
  ...over,
});

const LATER = "2099-01-01T10:00";

describe("the restrictions route", () => {
  it("is the person's own path on the path's tenant", () => {
    expect(personRestrictionsPath("t-1", "u-1")).toBe("/auth/tenants/t-1/users/u-1/restrictions");
    expect(personRestrictionsPath("t-1", "u-1", "configs_max")).toBe("/auth/tenants/t-1/users/u-1/restrictions/configs_max");
  });
});

describe("the write body", () => {
  it("sends a count as a whole number, not the text typed", () => {
    const d = { ...draftOf(SERVICES), count: " 5 ", reason: "  too many trials  " };
    expect(restrictionWriteBody(d, SERVICES)).toEqual({ value: 5, reason: "too many trials", expiresAt: null });
  });

  it("sends a set as its options, and an expiry as an instant", () => {
    const d = { ...draftOf(TOPUP), options: ["in_chat", "crypto"], reason: "disputed payments", expiresAt: LATER };
    expect(restrictionWriteBody(d, TOPUP)).toEqual({ value: ["crypto", "in_chat"], reason: "disputed payments", expiresAt: instantOf(LATER) });
  });

  it("starts a change from what holds now", () => {
    const d = draftOf(SERVICES, { key: "services_active_max", value: 3, reason: "chargeback", by: "u", at: "2026-10-01T00:00:00Z", expiresAt: null });
    expect(d).toMatchObject({ key: "services_active_max", count: "3", reason: "chargeback", expiresAt: null });
    expect(draftOf(TOPUP, { key: "topup_categories_barred", value: ["crypto"], reason: "x", by: "u", at: "2026-10-01T00:00:00Z", expiresAt: null }).options).toEqual(["crypto"]);
  });
});

describe("Save is offered only for what the route takes", () => {
  const ok = (over: object, key: RestrictionKeyView = SERVICES) => restrictionDraftOk({ ...draftOf(key), count: "3", options: ["crypto"], reason: "a reason", ...over }, key);

  it("takes a count from 0 to the key's max, whole", () => {
    expect(ok({ count: "0" })).toBe(true);
    expect(ok({ count: "10000" })).toBe(true);
    expect(ok({ count: "10001" })).toBe(false);
    expect(ok({ count: "2.5" })).toBe(false);
    expect(ok({ count: "-1" })).toBe(false);
    expect(ok({ count: "" })).toBe(false);
  });

  it("takes a set of at least one option", () => {
    expect(ok({}, TOPUP)).toBe(true);
    expect(ok({ options: [] }, TOPUP)).toBe(false);
  });

  it("wants a reason and an expiry still ahead", () => {
    expect(ok({ reason: "ab" })).toBe(false);
    expect(ok({ expiresAt: LATER })).toBe(true);
    expect(ok({ expiresAt: "2001-01-01T10:00" })).toBe(false);
  });
});

describe("adding a restriction", () => {
  it("offers only the keys not set yet", () => {
    expect(unsetKeys(view()).map((k) => k.key)).toEqual(["configs_max", "topup_categories_barred"]);
  });

  it("has a sentence for every restriction refusal the service names", () => {
    const union = /export type UserRestrictionsRejection =([\s\S]*?);/.exec(readFileSync(join(REPO, SERVICE), "utf8"));
    if (!union) throw new Error("UserRestrictionsRejection is no longer a literal union — this test is stale");
    // The door's reasons (ResellerAccessRejection, consent) have their sentences in useUserMessage.
    const own = [...union[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).filter((r) => r !== "user_not_found");
    expect(own.length).toBeGreaterThan(0);
    for (const reason of own) expect(Object.keys(RESTRICTION_REFUSAL_KEYS)).toContain(reason);
  });
});
