import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { PANEL_MY_RESELLERS, myResellerConsolePath, myResellerDomainsPath } from "@/lib/routes";
import type { ResellerOnboarding } from "@/lib/tenant-api";
import {
  CLOSED_CAPABILITY_KEYS,
  ONBOARDING_REFUSAL_KEYS,
  STEP_KEYS,
  consoleState,
  onboardingRefusalKey,
  splitSteps,
  stepHref,
} from "./_lib/onboarding";

/**
 * The onboarding console, `/my-resellers/[id]` (F-066-w, ADR-0064 (4)). What
 * breaks with nothing red anywhere:
 *  - **four equal steps.** Only `domain` closes anything; a page that lists the
 *    other three beside it tells an owner they cannot open without a bot;
 *  - **a step, a closed capability or a refusal with no sentence.** Each is
 *    read from tenant-service's or shared-core's own source, so a value added
 *    there fails here instead of reaching an owner as a blank line;
 *  - **a step that links somewhere the reseller is not configured.** The
 *    ambient `/gateways` configures the platform's own, not the reseller's
 *    (ADR-0064) — a step without its workspace screen links nothing;
 *  - **a link to a path Next does not serve.**
 */
const REPO = join(__dirname, "../../../../..");
const read = (path: string) => readFileSync(join(REPO, "txnet-backend", path), "utf8");

function unionOf(file: string, name: string): string[] {
  const union = new RegExp(`export type ${name} =([\\s\\S]*?);`).exec(read(file));
  if (!union) throw new Error(`${name} is no longer a literal union — this test is stale`);
  return [...union[1].matchAll(/'([a-zA-Z_]+)'/g)].map((m) => m[1]);
}

const SERVICE = "tenant-service/src/app/onboarding/tenant-onboarding.service.ts";

const view = (onboarding: boolean, done: Partial<Record<"domain" | "gateway" | "bot" | "pricing", boolean>> = {}) =>
  ({
    tenantId: "t-1",
    onboarding,
    closed: onboarding ? ["register", "sell", "endUserDeposit", "subscriptionLink"] : [],
    complete: ["domain", "gateway", "bot", "pricing"].every((k) => done[k as keyof typeof done]),
    steps: (["domain", "gateway", "bot", "pricing"] as const).map((key) => ({
      key,
      done: done[key] ?? false,
      gate: key === "domain",
    })),
  }) satisfies ResellerOnboarding;

describe("what the checklist can hold", () => {
  it("has a title for every step the service computes", () => {
    expect(Object.keys(STEP_KEYS).sort()).toEqual(unionOf(SERVICE, "OnboardingStepKey").sort());
  });

  it("names every capability the onboarding column closes, and no other", () => {
    const policy = /TenantOnboardingPolicy[^=]*=\s*\{([^}]*)\}/.exec(read("shared-core/src/lib/tenant/status-policy.ts"));
    const closed = [...policy![1].matchAll(/(\w+):\s*false/g)].map((m) => m[1]);
    expect(Object.keys(CLOSED_CAPABILITY_KEYS).sort()).toEqual(closed.sort());
  });

  it("has a sentence for every reason the route refuses with", () => {
    const reasons = unionOf("shared-core/src/lib/tenant/reseller-access.ts", "ResellerAccessRejection");
    expect(Object.keys(ONBOARDING_REFUSAL_KEYS).sort()).toEqual(reasons.sort());
    expect(onboardingRefusalKey({ reason: "reseller_suspended" })).toBe(ONBOARDING_REFUSAL_KEYS.reseller_suspended);
    expect(onboardingRefusalKey({ reason: "domain_taken" })).toBeNull();
    expect(onboardingRefusalKey(new Error("offline"))).toBeNull();
  });
});

describe("the gate is not one step of four", () => {
  it("puts the gating step apart from the ones that refuse nothing", () => {
    const { gate, rest } = splitSteps(view(true));
    expect(gate?.key).toBe("domain");
    expect(rest.map((s) => s.key)).toEqual(["gateway", "bot", "pricing"]);
    expect(rest.every((s) => !s.gate)).toBe(true);
  });

  it("follows the service's gate flag, not the step's name", () => {
    const v = view(true);
    const moved = { ...v, steps: v.steps.map((s) => ({ ...s, gate: s.key === "gateway" })) };
    expect(splitSteps(moved).gate?.key).toBe("gateway");
  });

  it("reads closed from `onboarding`, open from it too — never from `complete`", () => {
    expect(consoleState(view(true, { gateway: true, bot: true, pricing: true }))).toBe("closed");
    expect(consoleState(view(false, { domain: true }))).toBe("open");
    expect(consoleState(view(false, { domain: true, gateway: true, bot: true, pricing: true }))).toBe("complete");
  });
});

describe("where a step sends the owner", () => {
  it("links the domain step to the reseller's own domains screen", () => {
    expect(stepHref("domain", "t-1")).toBe(myResellerDomainsPath("t-1"));
  });

  it("links nothing for a step whose workspace screen is not built yet", () => {
    expect(stepHref("gateway", "t-1")).toBeNull();
    expect(stepHref("bot", "t-1")).toBeNull();
    expect(stepHref("pricing", "t-1")).toBeNull();
  });

  it("builds the path the app actually serves", () => {
    expect(myResellerConsolePath("t-1")).toBe(`${PANEL_MY_RESELLERS}/t-1`);
    expect(myResellerConsolePath("a b/c")).toBe(`${PANEL_MY_RESELLERS}/a%20b%2Fc`);
    expect(existsSync(join(__dirname, "[id]", "page.tsx"))).toBe(true);
  });
});
