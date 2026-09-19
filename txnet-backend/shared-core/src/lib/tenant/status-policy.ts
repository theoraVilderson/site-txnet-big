import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { BackendI18nKeys } from '../i18n/keys.backend.generated';
import { UnscopedRedisKeys } from '../redis/keys';
import { TenantContext } from '../tenant-context/tenant-context';

/**
 * What a tenant's status allows, as one matrix (F-018-f, D-42 (1), ADR-0057).
 *
 * The rules are `docs/domains/tenant/rules.md`; this is their one executable
 * copy. Every service that serves a tenant's users registers
 * {@link TenantStatusGuard} and labels its routes with a capability — nothing
 * else in the platform decides what a suspended or terminated tenant may do.
 */

/** Mirrors `tenant.TenantStatus` in the schema (C-09). */
export const TENANT_STATUSES = ['trial', 'active', 'suspended', 'terminated'] as const;
export type TenantStatusValue = (typeof TENANT_STATUSES)[number];

/**
 * What a route does, from the point of view of a tenant's status.
 *
 * - `signIn` — signing in, refreshing, captcha, OTP delivery, account recovery.
 * - `signOut` — ending a session. Never refused: a closed tenant's session
 *   should be able to leave.
 * - `read` — seeing anything. The default for a `GET`.
 * - `account` — a signed-in user changing their own account (email, switching).
 * - `staffWrite` — the reseller's panel changing anything. **The default for
 *   every mutating route that declares nothing**, so a route added next year
 *   is closed for a suspended tenant without its author remembering.
 * - `tenantBilling` — the reseller paying the platform (the billing top-up).
 * - `register` — a new end user.
 * - `sell` — an end user buying a service.
 * - `endUserDeposit` — an end user putting money in (deposits, gift cards).
 * - `system` — the platform settling what already happened: a gateway webhook
 *   or callback for a payment already taken, expiry, notifications. Refusing
 *   it loses a record of money that moved, so no status closes it.
 * - `subscriptionLink` — `/sub`. Enforced by `network`'s service when it
 *   exists; the matrix and `graceEndsAt` are here now.
 */
export const TENANT_CAPABILITIES = [
  'signIn',
  'signOut',
  'read',
  'account',
  'staffWrite',
  'tenantBilling',
  'register',
  'sell',
  'endUserDeposit',
  'system',
  'subscriptionLink',
] as const;
export type TenantCapabilityName = (typeof TENANT_CAPABILITIES)[number];

/** `hold`: allowed until the tenant's `graceEndsAt`, refused after (or with none). */
export type TenantStatusRule = boolean | 'hold';

const OPEN: Record<TenantCapabilityName, TenantStatusRule> = {
  signIn: true,
  signOut: true,
  read: true,
  account: true,
  staffWrite: true,
  tenantBilling: true,
  register: true,
  sell: true,
  endUserDeposit: true,
  system: true,
  subscriptionLink: true,
};

export const TenantStatusPolicy: Readonly<
  Record<TenantStatusValue, Readonly<Record<TenantCapabilityName, TenantStatusRule>>>
> = {
  trial: OPEN,
  active: OPEN,
  suspended: {
    signIn: true,
    signOut: true,
    read: true,
    account: true,
    staffWrite: false,
    tenantBilling: true,
    register: false,
    sell: false,
    endUserDeposit: false,
    system: true,
    subscriptionLink: 'hold',
  },
  terminated: {
    signIn: false,
    signOut: true,
    read: false,
    account: false,
    staffWrite: false,
    tenantBilling: false,
    register: false,
    sell: false,
    endUserDeposit: false,
    system: true,
    subscriptionLink: false,
  },
};

/**
 * The onboarding gate (F-018-l, catalog F-213): **a fifth column of the matrix
 * above**, applied on top of a reseller's status while it has no `verified`
 * custom domain of its own.
 *
 * Such a reseller has nowhere to serve its users — the platform's domain is
 * not its shop — so it reaches only the configuration console: it signs in,
 * reads, configures (`staffWrite`) and tops its billing wallet up, and it
 * registers nobody, sells nothing, takes no end-user money and serves no
 * `/sub`. The column closes exactly the four capabilities that need a door of
 * the reseller's own, which is why it is a column and not a status: a tenant
 * is `trial` or `active` *and* onboarding, and both are judged
 * ({@link tenantAllows} takes the stricter answer).
 *
 * The checklist the console shows (domain, gateway, bot, pricing) is computed
 * from live state by `tenant-service`'s onboarding route and stored nowhere;
 * only the domain half is this gate — `contract.onboarding.md`.
 */
export const TenantOnboardingPolicy: Readonly<Record<TenantCapabilityName, TenantStatusRule>> = {
  signIn: true,
  signOut: true,
  read: true,
  account: true,
  staffWrite: true,
  tenantBilling: true,
  register: false,
  sell: false,
  endUserDeposit: false,
  system: true,
  subscriptionLink: false,
};

/** What Redis holds per tenant, under `UnscopedRedisKeys.tenantStatus`. */
export interface TenantStatusState {
  status: TenantStatusValue;
  /** ISO timestamp; set while suspended. */
  graceEndsAt: string | null;
  /**
   * F-018-l: the reseller holds no `verified` custom domain, so
   * {@link TenantOnboardingPolicy} applies too. Absent is not onboarding —
   * a reader written before this column keeps the behaviour it had.
   */
  onboarding?: boolean;
}

/** Both columns in play have to allow it: the status's, and onboarding's while it is on. */
export function tenantAllows(
  state: TenantStatusState,
  capability: TenantCapabilityName,
  now: Date = new Date(),
): boolean {
  if (!applies(TenantStatusPolicy[state.status][capability], state, now)) return false;
  return !state.onboarding || applies(TenantOnboardingPolicy[capability], state, now);
}

function applies(rule: TenantStatusRule, state: TenantStatusState, now: Date): boolean {
  if (rule !== 'hold') return rule;
  return state.graceEndsAt !== null && now.getTime() <= Date.parse(state.graceEndsAt);
}

export function serializeTenantStatusState(state: TenantStatusState): string {
  return JSON.stringify({
    status: state.status,
    graceEndsAt: state.graceEndsAt,
    onboarding: state.onboarding ?? false,
  });
}

/** `null` for anything that is not a state this file wrote — which the guard treats as unknown. */
export function parseTenantStatusState(raw: string | null): TenantStatusState | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { status?: unknown; graceEndsAt?: unknown; onboarding?: unknown };
    if (!TENANT_STATUSES.includes(value.status as TenantStatusValue)) return null;
    const grace = typeof value.graceEndsAt === 'string' ? value.graceEndsAt : null;
    return {
      status: value.status as TenantStatusValue,
      graceEndsAt: grace,
      onboarding: value.onboarding === true,
    };
  } catch {
    return null;
  }
}

export const TENANT_CAPABILITY_KEY = 'tenant_capability';

/** Labels a route (or a controller) with what it does; see {@link TENANT_CAPABILITIES}. */
export const TenantCapability = (capability: TenantCapabilityName) =>
  SetMetadata(TENANT_CAPABILITY_KEY, capability);

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** A declared capability wins; otherwise a read method reads and anything else is a staff write. */
export function capabilityOf(
  method: string,
  declared: TenantCapabilityName | undefined,
): TenantCapabilityName {
  if (declared) return declared;
  return READ_METHODS.has(method.toUpperCase()) ? 'read' : 'staffWrite';
}

/** The DI token an app binds its `RedisService` to (anything with `get`). */
export const TENANT_STATUS_STORE = Symbol('TENANT_STATUS_STORE');
export interface TenantStatusStore {
  get(key: string): Promise<string | null>;
}

type Refusal = { i18nKey: string; reason: string };

const REFUSAL: Record<Exclude<TenantStatusValue, 'trial' | 'active'>, Refusal> = {
  suspended: { i18nKey: BackendI18nKeys.errors.tenant.suspended, reason: 'tenantSuspended' },
  terminated: { i18nKey: BackendI18nKeys.errors.tenant.terminated, reason: 'tenantTerminated' },
};

/** The gate a reseller leaves by proving a domain, not by paying (F-018-l). */
const ONBOARDING_REFUSAL: Refusal = {
  i18nKey: BackendI18nKeys.errors.tenant.onboarding,
  reason: 'tenantOnboarding',
};

/** Why this request was refused: the status closed it, or the onboarding gate did. */
export function tenantRefusal(state: TenantStatusState): Refusal {
  const byStatus = REFUSAL[state.status as keyof typeof REFUSAL];
  return byStatus ?? ONBOARDING_REFUSAL;
}

/**
 * Refuses a request its tenant's status does not allow (F-018-f). Registered
 * as an `APP_GUARD` by `auth-service` and `billing-service`.
 *
 * The state is the one `tenant-service`'s `TenantStatusListener` writes on a
 * Postgres notification. **A missing or unreadable key refuses nobody** — the
 * same trade F-101-b made: the listener recomputes every tenant on each
 * connect, so the window is a boot, and refusing on a missing key would take
 * every tenant down with Redis. A request with no tenant in scope is not this
 * guard's to judge (`TenantGuard` and the identity middleware are).
 */
@Injectable()
export class TenantStatusGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(TENANT_STATUS_STORE) private readonly store: TenantStatusStore,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const tenant = TenantContext.currentOrNull();
    if (!tenant) return true;

    const state = parseTenantStatusState(await this.store.get(UnscopedRedisKeys.tenantStatus(tenant.id)));
    if (!state) return true;

    const declared = this.reflector.getAllAndOverride<TenantCapabilityName | undefined>(
      TENANT_CAPABILITY_KEY,
      [context.getHandler(), context.getClass()],
    );
    const request = context.switchToHttp().getRequest<{ method: string }>();
    if (tenantAllows(state, capabilityOf(request.method, declared))) return true;

    // A `trial` or `active` tenant only ever reaches here through the
    // onboarding column, which is what {@link tenantRefusal} falls back to.
    throw new ForbiddenException(tenantRefusal(state));
  }
}
