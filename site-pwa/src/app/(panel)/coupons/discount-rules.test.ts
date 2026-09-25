import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { DiscountRule } from "@/lib/billing-api";
import {
  RULE_KEYS,
  RULE_NAME_MAX,
  RULE_REFUSAL_KEYS,
  RULE_STATUS_TONES,
  RULE_USERS_MAX,
  createRuleBody,
  emptyRuleForm,
  formFromRule,
  ruleRefusalKey,
  tehranToday,
  updateRuleBody,
  validateRuleForm,
  type RuleForm,
} from "./_lib/discount-rules";

/**
 * The coupons page, tab 3 — discounts with no code (F-114-k, ADR-0087). What
 * breaks without a browser to see it:
 *  - **a refusal with no sentence** — every reason `DiscountRuleAdminService`
 *    can send has a line here, read out of its own source;
 *  - **the form sending what billing refuses** — value, one target, one
 *    audience, a window that ends after it starts;
 *  - **an edit that leaves two audiences** — switching named users to a group
 *    must clear the names in the same write, or billing answers `one_audience`;
 *  - **an edit that moves what nobody touched** — a mid-day start re-sent as
 *    midnight;
 *  - **the last day picked not counting** — billing reads `endsAt` as exclusive.
 */
const REPO = join(__dirname, "../../../../..");
const DISCOUNT = join(REPO, "txnet-backend/billing-service/src/app/invoice/discount");
const LOCALES = join(REPO, "locales/frontend/langs");

function unionOf(file: string, name: string): string[] {
  const union = new RegExp(`export type ${name} =([\\s\\S]*?);`).exec(readFileSync(join(DISCOUNT, file), "utf8"));
  if (!union) throw new Error(`${name} is no longer a literal union — this test is stale`);
  return [...union[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const G = "33333333-3333-4333-8333-333333333333";

const RULE: DiscountRule = {
  id: "r1",
  name: "Nowruz",
  kind: "percentage",
  value: "15.00",
  productId: A,
  categoryId: null,
  forNamedUsers: true,
  userIds: [A, B],
  groupId: null,
  // 10:30 in Tehran — made through the API, not at a day's edge.
  startsAt: "2026-03-20T07:00:00.000Z",
  // The first instant of 2026-04-03 in Tehran: the form shows 2026-04-02.
  endsAt: "2026-04-02T20:30:00.000Z",
  isActive: true,
  status: "running",
  createdAt: "2026-03-01T00:00:00.000Z",
  updatedAt: "2026-03-01T00:00:00.000Z",
};

const form = (patch: Partial<RuleForm> = {}): RuleForm => ({ ...emptyRuleForm(Date.parse("2026-09-25T12:00:00Z")), name: "Autumn", value: "10", ...patch });

describe("billing's refusals and statuses", () => {
  it("has a sentence for every reason the service can refuse with", () => {
    expect(Object.keys(RULE_REFUSAL_KEYS).sort()).toEqual(unionOf("discount-rule-admin.service.ts", "DiscountRuleRejection").sort());
  });

  it("has a tone for every status billing answers", () => {
    expect(Object.keys(RULE_STATUS_TONES).sort()).toEqual(unionOf("discount-rule-admin.service.ts", "DiscountRuleStatus").sort());
  });

  it("never paints a status gold", () => {
    expect(Object.values(RULE_STATUS_TONES).join(" ")).not.toMatch(/gold|amber|yellow/);
  });

  it("picks the sentence from the reason, and nothing for an unknown one", () => {
    expect(ruleRefusalKey({ reason: "one_audience" })).toBe(RULE_KEYS.refusals.one_audience);
    expect(ruleRefusalKey({ reason: "code_taken" })).toBeNull();
    expect(ruleRefusalKey(null)).toBeNull();
  });

  it("holds the schema's bounds", () => {
    const schema = readFileSync(join(DISCOUNT, "discount-rule.schema.ts"), "utf8");
    expect(schema).toMatch(new RegExp(`name: z\\.string\\(\\)\\.trim\\(\\)\\.min\\(1\\)\\.max\\(${RULE_NAME_MAX}\\)`));
    expect(schema).toMatch(new RegExp(`userIds: z\\.array\\(uuid\\('userIds'\\)\\)\\.max\\(${RULE_USERS_MAX}\\)`));
  });
});

describe("validateRuleForm", () => {
  it("takes a plain rule for everyone and everything", () => {
    expect(validateRuleForm(form())).toEqual({});
  });

  it.each([
    ["0", "percentage", RULE_KEYS.errors.value],
    ["-5", "percentage", RULE_KEYS.errors.value],
    ["1.005", "fixed_amount", RULE_KEYS.errors.value],
    ["100.01", "percentage", RULE_KEYS.errors.percent],
  ] as const)("refuses value %s as a %s", (value, kind, key) => {
    expect(validateRuleForm(form({ value, kind })).value).toBe(key);
  });

  it("takes a fixed amount over 100 and a percentage of exactly 100", () => {
    expect(validateRuleForm(form({ kind: "fixed_amount", value: "250000.50" }))).toEqual({});
    expect(validateRuleForm(form({ value: "100" }))).toEqual({});
  });

  it("needs a name, within the schema's length", () => {
    expect(validateRuleForm(form({ name: "  " })).name).toBe(RULE_KEYS.errors.required);
    expect(validateRuleForm(form({ name: "x".repeat(RULE_NAME_MAX + 1) })).name).toBe(RULE_KEYS.errors.nameTooLong);
  });

  it("needs the product or category it names", () => {
    expect(validateRuleForm(form({ target: "product" })).productId).toBe(RULE_KEYS.errors.pickProduct);
    expect(validateRuleForm(form({ target: "category", categoryId: "nope" })).categoryId).toBe(RULE_KEYS.errors.pickCategory);
    expect(validateRuleForm(form({ target: "category", categoryId: A }))).toEqual({});
  });

  it("needs named users to name at least one, each a uuid", () => {
    expect(validateRuleForm(form({ audience: "named" })).userIds).toBe(RULE_KEYS.errors.needsUsers);
    expect(validateRuleForm(form({ audience: "named", userIds: `${A}, nope` })).userIds).toBe(RULE_KEYS.errors.uuid);
    expect(validateRuleForm(form({ audience: "named", userIds: `${A}\n${B}` }))).toEqual({});
  });

  it("needs a group to be picked", () => {
    expect(validateRuleForm(form({ audience: "group" })).groupId).toBe(RULE_KEYS.errors.pickGroup);
  });

  it("takes a one-day rule and refuses one that ends before it starts", () => {
    expect(validateRuleForm(form({ startsAt: "2026-10-01", endsAt: "2026-10-01" }))).toEqual({});
    expect(validateRuleForm(form({ startsAt: "2026-10-02", endsAt: "2026-10-01" })).endsAt).toBe(RULE_KEYS.errors.window);
  });
});

describe("createRuleBody", () => {
  it("sends no target, audience or end for everyone, everything, until switched off", () => {
    expect(createRuleBody(form())).toEqual({ name: "Autumn", kind: "percentage", value: "10", startsAt: "2026-09-25T00:00:00+03:30" });
  });

  it("starts today in Tehran, not in UTC", () => {
    // 22:00 UTC on the 25th is already the 26th in Tehran.
    expect(tehranToday(Date.parse("2026-09-25T22:00:00Z"))).toBe("2026-09-26");
  });

  it("counts the last day picked: billing reads the end as exclusive", () => {
    expect(createRuleBody(form({ endsAt: "2026-10-01" })).endsAt).toBe("2026-10-02T00:00:00+03:30");
  });

  it("sends named users de-duplicated, and a group alone", () => {
    expect(createRuleBody(form({ audience: "named", userIds: `${A} ${B}\n${A}` }))).toMatchObject({ forNamedUsers: true, userIds: [A, B] });
    const group = createRuleBody(form({ audience: "group", groupId: G, userIds: A }));
    expect(group).toMatchObject({ groupId: G });
    expect(group).not.toHaveProperty("userIds");
    expect(group).not.toHaveProperty("forNamedUsers");
  });

  it("sends a category without a product, and a rule saved off", () => {
    const body = createRuleBody(form({ target: "category", categoryId: A, productId: B, isActive: false }));
    expect(body).toMatchObject({ categoryId: A, isActive: false });
    expect(body).not.toHaveProperty("productId");
  });
});

describe("updateRuleBody", () => {
  it("round-trips a rule to an empty patch", () => {
    expect(updateRuleBody(formFromRule(RULE), RULE)).toEqual({});
  });

  it("shows the exclusive end as the last day it runs", () => {
    expect(formFromRule(RULE).endsAt).toBe("2026-04-02");
  });

  it("sends only the name when only the name changed — the mid-day start stays put", () => {
    expect(updateRuleBody({ ...formFromRule(RULE), name: "Nowruz 1405" }, RULE)).toEqual({ name: "Nowruz 1405" });
  });

  it("clears the names in the same write that picks a group", () => {
    expect(updateRuleBody({ ...formFromRule(RULE), audience: "group", groupId: G }, RULE)).toEqual({ forNamedUsers: false, groupId: G });
  });

  it("sends the whole user list when one is added", () => {
    const f = formFromRule(RULE);
    expect(updateRuleBody({ ...f, userIds: `${f.userIds}\n${G}` }, RULE)).toEqual({ forNamedUsers: true, userIds: [A, B, G], groupId: null });
  });

  it("moves the target as a unit, so a product and a category never stand together", () => {
    expect(updateRuleBody({ ...formFromRule(RULE), target: "category", categoryId: B }, RULE)).toEqual({ productId: null, categoryId: B });
    expect(updateRuleBody({ ...formFromRule(RULE), target: "all" }, RULE)).toEqual({ productId: null, categoryId: null });
  });

  it("does not re-send a value written differently but equal", () => {
    expect(updateRuleBody({ ...formFromRule(RULE), value: "15" }, RULE)).toEqual({});
  });

  it("switches a rule off, and clears an end", () => {
    expect(updateRuleBody({ ...formFromRule(RULE), isActive: false }, RULE)).toEqual({ isActive: false });
    expect(updateRuleBody({ ...formFromRule(RULE), endsAt: "" }, RULE)).toEqual({ endsAt: null });
  });
});

describe("every key this tab can reach", () => {
  const flatten = (v: unknown): string[] =>
    typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(flatten) : [];
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
    expect(flatten(RULE_KEYS).filter((k) => !keys.has(k))).toEqual([]);
  });
});
