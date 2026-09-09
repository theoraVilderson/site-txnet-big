import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TickMessage } from '../broker/broker.service';

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
 * What the gate decided about one tick.
 *
 * One object with optional halves rather than a discriminated union: this
 * workspace compiles without `strictNullChecks`, and without it a union
 * discriminated on a boolean does not narrow — every reader would need a cast,
 * which is worse than the shape being slightly looser.
 */
export interface Admission {
  admitted: boolean;
  /** Refused, but worth trying again — republish this after `afterMs`. */
  retry?: TickMessage;
  afterMs?: number;
  /** Refused for good, with the reason. Set instead of `retry`, never with it. */
  dropped?: string;
}

/**
 * Catalog 20.2 layer 4, F-1205: **a per-tenant concurrency cap.**
 *
 * `AUTOMATION_PREFETCH` already bounds how much this process runs at once, but
 * it bounds it in total. One tenant with a thousand due occurrences takes every
 * slot, and every other tenant's schedule stops firing — the isolation failure
 * layer 4 is named after, arriving as "the campaign never sent" rather than as
 * an error anyone can see.
 *
 * The cap is **per process**, which is the same grain `AUTOMATION_PREFETCH`
 * already has: N replicas give a tenant N budgets. That is stated rather than
 * solved, because solving it means a counter in Redis and this service holds no
 * Redis connection — a dependency added for a job that does not exist yet
 * (nothing published a tenant-scoped tick before this row, and nothing does
 * after it either). The shape that would replace it is a per-tenant queue, and
 * that is a topology decision, not a knob.
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
  /** tenantId -> runs of that tenant's work in flight in this process. */
  private readonly inFlightByTenant = new Map<string, number>();

  constructor(config: ConfigService) {
    this.cap = config.getOrThrow<number>('AUTOMATION_TENANT_CONCURRENCY');
    this.deferMs = config.getOrThrow<number>('AUTOMATION_DEFER_MS');
  }

  /**
   * Take a slot for this tick's tenant, if one is free.
   *
   * A tick that names no tenant is platform work — the heartbeat, the vault
   * retention sweep — and is never gated: it belongs to no tenant, so charging
   * it to one would let a platform sweep exhaust a reseller's budget.
   */
  admit(tick: TickMessage): Admission {
    const tenantId = tick.tenantId;
    if (!tenantId) return { admitted: true };

    const inFlight = this.inFlightByTenant.get(tenantId) ?? 0;
    if (inFlight < this.cap) {
      this.inFlightByTenant.set(tenantId, inFlight + 1);
      return { admitted: true };
    }

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
   * Give the slot back. Called from a `finally`, so it also runs for a tick
   * that was never admitted — hence the floor at zero: a release with no
   * matching admit must not hand the tenant an extra slot.
   */
  release(tick: TickMessage): void {
    const tenantId = tick.tenantId;
    if (!tenantId) return;

    const inFlight = this.inFlightByTenant.get(tenantId) ?? 0;
    // Deleted rather than left at zero. A long-lived process would otherwise
    // hold one entry per tenant that has ever run anything, for ever.
    if (inFlight <= 1) this.inFlightByTenant.delete(tenantId);
    else this.inFlightByTenant.set(tenantId, inFlight - 1);
  }

  /** For the spec and for a log line: what this process is running for a tenant. */
  inFlight(tenantId: string | undefined): number {
    return tenantId ? (this.inFlightByTenant.get(tenantId) ?? 0) : 0;
  }

  /** How many tenants are being tracked at all. */
  tracked(): number {
    return this.inFlightByTenant.size;
  }
}
