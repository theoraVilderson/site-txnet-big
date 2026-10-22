import { RENEWAL_CALLBACK_PREFIX, renewalOpenCallback } from '@txnet-backend/shared-core';
import type { GrantStatus, MyService } from '../billing-api/services.types';

/**
 * The renewal's buttons in the chat (F-305-i): `rnw:<kind>:<id>[:<plan>]`.
 * Each names its Grant or its invoice, so a tap on an old screen still means
 * what it says and needs no state; a plan is its place in billing's list — a
 * pair of uuids is past the 64-byte cap — and the invoice screen names what
 * it bought before anything is paid. The open one is shared-core's: a renew
 * notice carries it (auth-service `notice-buttons.ts`).
 */
const KIND = { open: 'o', plan: 'p', gib: 'g', days: 'd', pay: 'y', coupon: 'c', cancel: 'x' } as const;
export type RenewalKind = keyof typeof KIND;
const KIND_OF: Record<string, RenewalKind> = Object.fromEntries(Object.entries(KIND).map(([k, v]) => [v, k as RenewalKind]));

export const renewalAction = (kind: RenewalKind, id: string, plan?: number): string =>
  kind === 'open' ? renewalOpenCallback(id) : `${RENEWAL_CALLBACK_PREFIX}${KIND[kind]}:${id}${plan === undefined ? '' : `:${plan}`}`;

/** The button read back; `null` for one this build does not know. */
export function parseRenewalAction(actionId: string): { kind: RenewalKind; id: string; plan: number } | null {
  const [code, id, plan] = actionId.slice(RENEWAL_CALLBACK_PREFIX.length).split(':');
  const kind = KIND_OF[code];
  return kind && id ? { kind, id, plan: plan === undefined ? -1 : Number(plan) } : null;
}

/** The statuses billing renews (billing `contract.renewal.md` rule 1); any other is refused `grant_not_renewable`. */
const RENEWABLE: ReadonlySet<GrantStatus> = new Set<GrantStatus>(['active', 'suspended']);

/**
 * Whether a service's screen offers «تمدید» — the panel's own rule
 * (panel-web `contract.renewal.md` rule 1): one issued with no plan has no
 * product to renew within, and a button that can only be refused is not drawn.
 */
export function renewalOffered(s: Pick<MyService, 'status' | 'variant'>): boolean {
  return RENEWABLE.has(s.status) && s.variant !== null;
}
