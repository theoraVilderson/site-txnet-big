import { FrontendI18nKeys } from "@/generated/i18n-keys";
import type { SettlementRejection } from "@/lib/billing-api";

const R = FrontendI18nKeys.common.gateways.links.refusals;

/**
 * One sentence per reason `SettlementService` can refuse a link with (F-096-f).
 *
 * A settlement refusal carries no `i18nKey` — `settlement.schema.ts` names none,
 * by design — so `sanitizeError` puts the generic `system.conflict` /
 * `system.notFound` sentence in `message` and only `reason` reaches this page.
 * Linking twice, linking a tenant its own gateway and withdrawing a link that
 * is already withdrawn are three different things to fix and were one sentence.
 *
 * A `Record` over the union, as `coupons/_lib/coupon-form.ts` does: a reason
 * added to the service does not compile here, and `gateway-links.test.ts` reads
 * the service's own union for the case where both sides forgot.
 */
export const GRANT_REFUSAL_KEYS: Record<SettlementRejection, string> = {
  not_platform_owner: R.not_platform_owner,
  gateway_not_found: R.gateway_not_found,
  tenant_not_found: R.tenant_not_found,
  grant_to_owner: R.grant_to_owner,
  gateway_not_grantable: R.gateway_not_grantable,
  already_granted: R.already_granted,
  grant_not_found: R.grant_not_found,
  already_withdrawn: R.already_withdrawn,
  amount_not_positive: R.amount_not_positive,
  exceeds_outstanding: R.exceeds_outstanding,
};

/** The refusal's own sentence key, when settlement named a reason this page knows. */
export function grantRefusalKey(e: unknown): string | null {
  const reason = (e as { reason?: unknown } | null)?.reason;
  return typeof reason === "string" && reason in GRANT_REFUSAL_KEYS ? GRANT_REFUSAL_KEYS[reason as SettlementRejection] : null;
}
