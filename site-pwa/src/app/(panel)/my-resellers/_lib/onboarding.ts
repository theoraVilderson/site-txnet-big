import type { OnboardingStepKey, ResellerOnboarding } from "@/lib/tenant-api";
import { myResellerBotPath, myResellerCatalogPath, myResellerDomainsPath, myResellerGatewaysPath } from "@/lib/routes";
import { FrontendI18nKeys } from "@/generated/i18n-keys";

/** The console's strings as generated constants (C-06). */
export const ONBOARDING_KEYS = FrontendI18nKeys.common.resellerOnboarding;
const K = ONBOARDING_KEYS;

/** shared-core's `ResellerAccessRejection` (invariant 21): the only refusals the route has. */
export type OnboardingRefusal = "not_allowed" | "reseller_not_found" | "reseller_suspended" | "reseller_terminated";

export const ONBOARDING_REFUSAL_KEYS: Record<OnboardingRefusal, string> = K.refusals;

/** The refusal's own sentence key, when the service named one this page knows. */
export function onboardingRefusalKey(e: unknown): string | null {
  const reason = (e as { reason?: unknown } | null)?.reason;
  return typeof reason === "string" && reason in ONBOARDING_REFUSAL_KEYS
    ? ONBOARDING_REFUSAL_KEYS[reason as OnboardingRefusal]
    : null;
}

export const STEP_KEYS: Record<OnboardingStepKey, { title: string; hint: string }> = K.steps;

/**
 * What a customer cannot do while the gate is shut — the `false` cells of
 * shared-core's `TenantOnboardingPolicy`. The route sends the list; this is
 * only its wording, and the spec reads the policy from source.
 */
export type ClosedCapability = "register" | "sell" | "endUserDeposit" | "subscriptionLink";
export const CLOSED_CAPABILITY_KEYS: Record<ClosedCapability, string> = K.closed;

/**
 * `closed` while the gate is on, whatever else is done; `open` once it is off
 * with steps left; `complete` when every step is. Read from `onboarding`, never
 * from `complete`: a reseller opens with no bot at all.
 */
export type ConsoleState = "closed" | "open" | "complete";
export const consoleState = (v: ResellerOnboarding): ConsoleState =>
  v.onboarding ? "closed" : v.complete ? "complete" : "open";

/**
 * The step that gates, apart from the ones that refuse nothing — by the
 * service's `gate` flag, not by a name this page assumes.
 */
export function splitSteps(v: ResellerOnboarding) {
  return { gate: v.steps.find((s) => s.gate) ?? null, rest: v.steps.filter((s) => !s.gate) };
}

/**
 * The workspace screen that finishes a step, or `null` while it has none.
 * Never the ambient screen (`/gateways`, `/catalog`): those configure the
 * session's tenant — the platform's — not this reseller (ADR-0064). Every one
 * of the four now has its own.
 */
export function stepHref(key: OnboardingStepKey, id: string): string | null {
  if (key === "domain") return myResellerDomainsPath(id);
  if (key === "gateway") return myResellerGatewaysPath(id);
  if (key === "bot") return myResellerBotPath(id);
  if (key === "pricing") return myResellerCatalogPath(id);
  return null;
}
