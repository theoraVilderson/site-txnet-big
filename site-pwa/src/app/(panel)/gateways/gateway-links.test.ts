import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api-error";
import { GRANT_REFUSAL_KEYS, grantRefusalKey } from "./_lib/grants";

/**
 * The gateway-links panel's refusals (F-096-f).
 *
 * A settlement refusal carries no `i18nKey` by design (`settlement.schema.ts`),
 * so `sanitizeError` replaces its `message` with the generic conflict or
 * not-found sentence and only `reason` survives. Linking twice, linking a
 * tenant its own gateway and a grant already withdrawn therefore read the same
 * — which is what this page maps, exactly as the coupons page does.
 */

const REPO = join(__dirname, "../../../../..");
const SERVICE = join(REPO, "txnet-backend/billing-service/src/app/settlement/settlement.service.ts");
const LOCALES = join(REPO, "locales/frontend/langs");

function unionOf(name: string): string[] {
  const union = new RegExp(`export type ${name} =([\\s\\S]*?);`).exec(readFileSync(SERVICE, "utf8"));
  if (!union) throw new Error(`${name} is no longer a literal union — this test is stale`);
  return [...union[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

const refused = (reason: string) => new ApiError("conflict", { status: 409, reason });

describe("one sentence per settlement refusal", () => {
  it("covers every reason the service can refuse with", () => {
    expect(Object.keys(GRANT_REFUSAL_KEYS).sort()).toEqual(unionOf("SettlementRejection").sort());
  });

  it("picks the reason's own key, not the generic sentence", () => {
    expect(grantRefusalKey(refused("already_granted"))).toBe(GRANT_REFUSAL_KEYS.already_granted);
    expect(grantRefusalKey(refused("grant_to_owner"))).toBe(GRANT_REFUSAL_KEYS.grant_to_owner);
    expect(grantRefusalKey(refused("gateway_not_grantable"))).toBe(GRANT_REFUSAL_KEYS.gateway_not_grantable);
    expect(grantRefusalKey(refused("already_withdrawn"))).toBe(GRANT_REFUSAL_KEYS.already_withdrawn);
  });

  it("falls back to the generic sentence for anything it does not know", () => {
    expect(grantRefusalKey(refused("something_new"))).toBeNull();
    expect(grantRefusalKey(new ApiError("boom", { status: 500 }))).toBeNull();
    expect(grantRefusalKey(null)).toBeNull();
  });

  it.each(["en", "fa"])("every sentence is shipped in %s", (lang) => {
    const keys = new Set<string>();
    const walk = (prefix: string, value: unknown) => {
      if (value && typeof value === "object") for (const [k, c] of Object.entries(value)) walk(prefix ? `${prefix}.${k}` : k, c);
      else if (typeof value === "string") keys.add(prefix);
    };
    walk("", JSON.parse(readFileSync(join(LOCALES, lang, "common.json"), "utf8")));
    expect(Object.values(GRANT_REFUSAL_KEYS).filter((k) => !keys.has(k))).toEqual([]);
  });
});
