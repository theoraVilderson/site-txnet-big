import { ConfigService } from '@nestjs/config';
import { TickMessage } from '../broker/broker.service';
import {
  MAX_DEFERRALS,
  TenantConcurrencyGate,
} from './tenant-concurrency.gate';
import { TenantRunLeases } from './tenant-run.leases';

/**
 * F-066-p / F-067-e / catalog 20.2 layer 4 — **one tenant's background work
 * cannot occupy every slot, however many replicas are running.**
 *
 * The gate is still plain arithmetic about who is in flight; what F-067-e
 * changed is *where the count lives*. Counting moved into `TenantRunLeases`
 * (a Redis sorted set of expiring leases) so the answer is the same for every
 * replica, and the gate keeps the two things that are decisions rather than
 * storage: what a refusal does, and when a refusal becomes a give-up.
 *
 * That is why the store is faked here rather than mocked. The fake is a
 * counter, which is exactly what the gate is allowed to assume of it: the gate
 * must not care whether a slot was granted by Redis or by the in-process
 * fallback, and a spec that faked ioredis would be asserting Redis's
 * behaviour instead of ours.
 *
 * The case worth stating is still the silent one: a refused tick that is
 * neither run nor returned is work that disappears, and nothing downstream
 * would report it — the schedule simply appears not to have fired.
 */
describe('TenantConcurrencyGate', () => {
  const tick = (tenantId?: string, deferrals?: number): TickMessage => ({
    key: 'campaign_sender',
    at: '2026-09-09T10:00:00.000Z',
    reason: 'cron matched',
    triggeredBy: 'cron',
    ...(tenantId ? { tenantId } : {}),
    ...(deferrals ? { deferrals } : {}),
  });

  /**
   * A stand-in for the shared counter: one number per tenant, and a `fail`
   * switch for the case the real store cannot be asked at all.
   */
  const fakeLeases = () => {
    const held = new Map<string, Set<string>>();
    let seq = 0;
    return {
      fail: false,
      acquire(tenantId: string, cap: number) {
        if (this.fail) return Promise.reject(new Error('redis is unreachable'));
        const set = held.get(tenantId) ?? new Set<string>();
        held.set(tenantId, set);
        if (set.size >= cap) return Promise.resolve(null);
        const token = `lease-${++seq}`;
        set.add(token);
        return Promise.resolve(token);
      },
      release(tenantId: string, token: string) {
        if (this.fail) return Promise.reject(new Error('redis is unreachable'));
        held.get(tenantId)?.delete(token);
        return Promise.resolve();
      },
      count(tenantId: string) {
        if (this.fail) return Promise.reject(new Error('redis is unreachable'));
        return Promise.resolve(held.get(tenantId)?.size ?? 0);
      },
    };
  };

  type Fake = ReturnType<typeof fakeLeases>;

  const gate = (cap = 2, deferMs = 5000) => {
    const leases = fakeLeases();
    const g = new TenantConcurrencyGate(
      leases as unknown as TenantRunLeases,
      {
        getOrThrow: (name: string) =>
          name === 'AUTOMATION_TENANT_CONCURRENCY' ? cap : deferMs,
      } as unknown as ConfigService,
    );
    return { g, leases } as { g: TenantConcurrencyGate; leases: Fake };
  };

  it('admits up to the cap for one tenant and refuses the next', async () => {
    const { g } = gate(2);
    expect((await g.admit(tick('t1'))).admitted).toBe(true);
    expect((await g.admit(tick('t1'))).admitted).toBe(true);
    expect((await g.admit(tick('t1'))).admitted).toBe(false);
  });

  it('caps each tenant on its own — a busy tenant does not refuse a quiet one', async () => {
    const { g } = gate(1);
    expect((await g.admit(tick('t1'))).admitted).toBe(true);
    expect((await g.admit(tick('t1'))).admitted).toBe(false);
    expect((await g.admit(tick('t2'))).admitted).toBe(true);
  });

  it('never gates a tick that names no tenant, and never asks the store about one', async () => {
    // `worker_heartbeat`, `vault_credential_retention` and `outbox_relay` are
    // platform sweeps. They are nobody's tenant work, so no tenant's budget
    // pays for them — and, since F-067-e, they cost no Redis round trip
    // either: the ungated path is the common one and must stay free.
    const { g, leases } = gate(1);
    const acquire = jest.spyOn(leases, 'acquire');
    expect((await g.admit(tick())).admitted).toBe(true);
    expect((await g.admit(tick())).admitted).toBe(true);
    expect(acquire).not.toHaveBeenCalled();
  });

  it('frees the slot on release, and only that tenant’s', async () => {
    const { g } = gate(1);
    const admitted = await g.admit(tick('t1'));
    expect((await g.admit(tick('t1'))).admitted).toBe(false);
    await g.release(admitted.lease);
    expect((await g.admit(tick('t1'))).admitted).toBe(true);
  });

  it('releases the lease it was given, not the tenant’s whole budget', async () => {
    // Two runs of one tenant are two leases. Releasing one must return one
    // slot: a release that cleared the tenant would let a finished run hand
    // every other replica's in-flight work back to the pool.
    const { g, leases } = gate(2);
    const first = await g.admit(tick('t1'));
    await g.admit(tick('t1'));
    await g.release(first.lease);
    expect(await leases.count('t1')).toBe(1);
  });

  it('returns a refused tick for republication, counting the deferral', async () => {
    const { g } = gate(1);
    await g.admit(tick('t1'));
    const result = await g.admit(tick('t1'));
    expect(result.admitted).toBe(false);
    expect(result.retry).toEqual({ ...tick('t1'), deferrals: 1 });
    expect(result.afterMs).toBe(5000);
    // Nothing to give back — a refusal took no lease.
    expect(result.lease).toBeUndefined();
  });

  it('drops a tick that has been deferred too many times, rather than cycling it for ever', async () => {
    // A tenant whose runs never finish would otherwise accumulate one
    // permanently circling message per missed occurrence.
    const { g } = gate(1);
    await g.admit(tick('t1'));
    const result = await g.admit(tick('t1', MAX_DEFERRALS));
    expect(result.admitted).toBe(false);
    expect(result.retry).toBeUndefined();
    expect(result.dropped).toContain('t1');
  });

  it('releasing nothing does not create a negative budget', async () => {
    // The consumer releases in a `finally`, so a throw before the admit calls
    // this with the `undefined` lease of a tick that was never admitted.
    const { g } = gate(1);
    await g.release(undefined);
    expect((await g.admit(tick('t1'))).admitted).toBe(true);
    expect((await g.admit(tick('t1'))).admitted).toBe(false);
  });

  describe('when the shared counter cannot be reached', () => {
    /**
     * The degradation F-067-e chose (`ASSUMED(2026-09-10)`): a Redis that is
     * down falls back to counting in this process — F-066-p's behaviour, which
     * is a weaker cap and not no cap. Deferring instead would turn a fairness
     * control into an outage, and every tenant tick would dead-letter after
     * `MAX_DEFERRALS`.
     */
    it('still caps the tenant, in this process', async () => {
      const { g, leases } = gate(1);
      leases.fail = true;
      expect((await g.admit(tick('t1'))).admitted).toBe(true);
      expect((await g.admit(tick('t1'))).admitted).toBe(false);
      expect((await g.admit(tick('t2'))).admitted).toBe(true);
    });

    it('releases a local lease locally, so the fallback is not one-way', async () => {
      const { g, leases } = gate(1);
      leases.fail = true;
      const admitted = await g.admit(tick('t1'));
      await g.release(admitted.lease);
      expect((await g.admit(tick('t1'))).admitted).toBe(true);
    });

    it('forgets a tenant once it is idle, so the local map does not grow for ever', async () => {
      const { g, leases } = gate(1);
      leases.fail = true;
      const admitted = await g.admit(tick('t1'));
      await g.release(admitted.lease);
      expect(g.trackedLocally()).toBe(0);
    });

    it('does not fail a run because the lease could not be handed back', async () => {
      // `release` is called from a `finally`. A throw here would replace the
      // job's own outcome with a Redis error, and the lease expires on its own
      // deadline anyway — that is what makes it a lease rather than a counter.
      const { g, leases } = gate(1);
      const admitted = await g.admit(tick('t1'));
      leases.fail = true;
      await expect(g.release(admitted.lease)).resolves.toBeUndefined();
    });
  });
});
