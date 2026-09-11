import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TickMessage } from '../broker/broker.service';
import { TenantRunLeases } from './tenant-run.leases';

/**
 * How many times one tick may be handed back to the exchange before it is
 * given up on. A constant rather than a variable: it is not a knob anybody
 * would turn per deployment — the two that shape the behaviour are the cap and
 * the delay, and this one only bounds the pathological case where a tenant's
 * runs never finish at all. At the default delay that is a little under two
 * minutes of trying.
 */
export const MAX_DEFERRALS = 20;

/**
 * A slot this tick holds, and where it was taken from.
 *
 * `shared: false` is a lease granted by the in-process fallback below rather
 * than by Redis. It rides on the admission so `release` gives the slot back
 * where it came from: a process that lost Redis mid-run must not try to
 * `ZREM` a member it never wrote, and one that regained it must not decrement
 * a local count that was never incremented.
 */
export interface TenantLease {
  tenantId: string;
  token: string;
  shared: boolean;
}

/**
 * What the gate decided about one tick.
 *
 * One object with optional halves rather than a discriminated union: this
 * workspace compiles without `strictNullChecks`, and without it a union
 * discriminated on a boolean does not narrow — every reader would need a cast,
 * which is worse than the shape being slightly looser.
 */
export interface Admission {
  admitted: boolean;
  /** The slot that was taken. Set only when `admitted` and the tick names a tenant. */
  lease?: TenantLease;
  /** Refused, but worth trying again — republish this after `afterMs`. */
  retry?: TickMessage;
  afterMs?: number;
  /** Refused for good, with the reason. Set instead of `retry`, never with it. */
  dropped?: string;
}

/** The token a fallback lease carries. It is never sent to Redis. */
const LOCAL_TOKEN = 'local';

/**
 * Catalog 20.2 layer 4, F-1205: **a per-tenant concurrency cap.**
 *
 * `AUTOMATION_PREFETCH` already bounds how much this process runs at once, but
 * it bounds it in total. One tenant with a thousand due occurrences takes every
 * slot, and every other tenant's schedule stops firing — the isolation failure
 * layer 4 is named after, arriving as "the campaign never sent" rather than as
 * an error anyone can see.
 *
 * **The count is shared** (F-067-e, D-17). F-066-p kept it in a `Map` on this
 * process, which gave one tenant N budgets across N replicas — a cap that stops
 * meaning anything at exactly the scale it exists for. It now lives in Redis,
 * behind `TenantRunLeases`, and the arithmetic here is unchanged: everything
 * this class decides is about what a refusal *does*, which is the part a
 * counter cannot answer.
 *
 * **A refused tick is returned to the exchange, not dropped and not held.**
 * The three alternatives are each worse in a way worth naming:
 *
 * - *Holding it* — awaiting a free slot inside the handler — keeps one of
 *   `AUTOMATION_PREFETCH`'s slots occupied by a tick that is not running. Fill
 *   them all with one tenant's waiting work and the queue stops draining for
 *   everyone, which is the exact failure the cap exists to prevent.
 * - *Nacking with requeue* puts it back at the **head** of the queue, so it is
 *   redelivered immediately, refused again, and spins at broker speed.
 * - *Dropping it* loses work silently, and for an `admin_manual` run there is
 *   no next occurrence to recover it.
 *
 * Returning it puts it behind everything already queued — every other tenant's
 * work goes first — and the `deferrals` count on the message makes the yielding
 * visible in a log line rather than inferable from a gap.
 */
@Injectable()
export class TenantConcurrencyGate {
  private readonly logger = new Logger(TenantConcurrencyGate.name);
  private readonly cap: number;
  private readonly deferMs: number;
  /**
   * tenantId -> runs of that tenant's work in flight **in this process**.
   *
   * Since F-067-e this is the fallback, not the mechanism: it is written only
   * while Redis cannot be reached. Between F-066-p and F-067-e it was the
   * whole cap.
   */
  private readonly localByTenant = new Map<string, number>();

  constructor(
    private readonly leases: TenantRunLeases,
    config: ConfigService,
  ) {
    this.cap = config.getOrThrow<number>('AUTOMATION_TENANT_CONCURRENCY');
    this.deferMs = config.getOrThrow<number>('AUTOMATION_DEFER_MS');
  }

  /**
   * Take a slot for this tick's tenant, if one is free.
   *
   * A tick that names no tenant is platform work — the heartbeat, the vault
   * retention sweep, the outbox relay — and is never gated: it belongs to no
   * tenant, so charging it to one would let a platform sweep exhaust a
   * reseller's budget. It also costs no round trip, which matters because it is
   * every tick this platform publishes today.
   */
  async admit(tick: TickMessage): Promise<Admission> {
    const tenantId = tick.tenantId;
    if (!tenantId) return { admitted: true };

    const lease = await this.take(tenantId);
    if (lease) return { admitted: true, lease };

    const deferrals = tick.deferrals ?? 0;
    if (deferrals >= MAX_DEFERRALS) {
      const dropped =
        `tenant ${tenantId} has been at its cap of ${this.cap} for ` +
        `${MAX_DEFERRALS} deferrals — dropping tick ${tick.key}`;
      this.logger.error(dropped);
      return { admitted: false, dropped };
    }

    this.logger.warn(
      `tenant ${tenantId} is at its cap of ${this.cap} — deferring tick ` +
        `${tick.key} (deferral ${deferrals + 1})`,
    );
    return {
      admitted: false,
      retry: { ...tick, deferrals: deferrals + 1 },
      afterMs: this.deferMs,
    };
  }

  /**
   * Give the slot back. Called from a `finally`, so it is also called with the
   * `undefined` lease of a tick that was never admitted — and it never throws,
   * because a Redis failure here must not replace the job's own outcome. The
   * lease expires at its own deadline anyway; that is what makes it a lease
   * rather than a counter.
   */
  async release(lease: TenantLease | undefined): Promise<void> {
    if (!lease) return;
    if (!lease.shared) {
      this.releaseLocally(lease.tenantId);
      return;
    }
    try {
      await this.leases.release(lease.tenantId, lease.token);
    } catch (err) {
      this.logger.warn(
        `could not return ${lease.tenantId}'s run slot — it expires on its ` +
          `own: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Live runs for a tenant across every replica. For a log line and the admin eye. */
  async inFlight(tenantId: string | undefined): Promise<number> {
    if (!tenantId) return 0;
    try {
      return await this.leases.count(tenantId);
    } catch {
      return this.localByTenant.get(tenantId) ?? 0;
    }
  }

  /** How many tenants the *fallback* is tracking. Zero whenever Redis is healthy. */
  trackedLocally(): number {
    return this.localByTenant.size;
  }

  /**
   * Ask the shared counter, and fall back to this process's own count when it
   * cannot be reached.
   *
   * `ASSUMED(2026-09-10)`: degrade rather than refuse. Deferring on a Redis
   * error is the tidier answer and the wrong one — every tenant tick would
   * yield, and after `MAX_DEFERRALS` dead-letter, so a fairness control would
   * become an outage for exactly the tenants it protects. The fallback is
   * F-066-p's cap: weaker than the shared one, much stronger than none, and
   * it is what the whole platform ran on until today.
   */
  private async take(tenantId: string): Promise<TenantLease | null> {
    try {
      const token = await this.leases.acquire(tenantId, this.cap);
      return token ? { tenantId, token, shared: true } : null;
    } catch (err) {
      this.logger.error(
        `shared tenant counter unreachable — capping ${tenantId} in this ` +
          `process only: ${err instanceof Error ? err.message : String(err)}`,
      );
      return this.takeLocally(tenantId);
    }
  }

  private takeLocally(tenantId: string): TenantLease | null {
    const inFlight = this.localByTenant.get(tenantId) ?? 0;
    if (inFlight >= this.cap) return null;
    this.localByTenant.set(tenantId, inFlight + 1);
    return { tenantId, token: LOCAL_TOKEN, shared: false };
  }

  private releaseLocally(tenantId: string): void {
    const inFlight = this.localByTenant.get(tenantId) ?? 0;
    // Deleted rather than left at zero. A long-lived process would otherwise
    // hold one entry per tenant that has ever run anything, for ever.
    if (inFlight <= 1) this.localByTenant.delete(tenantId);
    else this.localByTenant.set(tenantId, inFlight - 1);
  }
}
