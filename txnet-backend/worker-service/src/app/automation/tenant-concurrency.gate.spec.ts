import { ConfigService } from '@nestjs/config';
import { TickMessage } from '../broker/broker.service';
import {
  MAX_DEFERRALS,
  TenantConcurrencyGate,
} from './tenant-concurrency.gate';

/**
 * F-066-p / catalog 20.2 layer 4 — **one tenant's background work cannot
 * occupy every slot this process has.**
 *
 * The gate is the whole of that rule, which is why it is a plain object with
 * no broker and no database in it: what must be true here is arithmetic about
 * who is in flight, and it is testable as arithmetic. What the consumer adds
 * is the two side effects — running the handler, and putting a refused tick
 * back on the exchange.
 *
 * The case worth stating is the one that fails silently: a refused tick that
 * is neither run nor returned is work that disappears, and nothing downstream
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

  const gate = (cap = 2, deferMs = 5000) =>
    new TenantConcurrencyGate({
      getOrThrow: (name: string) =>
        name === 'AUTOMATION_TENANT_CONCURRENCY' ? cap : deferMs,
    } as unknown as ConfigService);

  it('admits up to the cap for one tenant and refuses the next', () => {
    const g = gate(2);
    expect(g.admit(tick('t1')).admitted).toBe(true);
    expect(g.admit(tick('t1')).admitted).toBe(true);
    expect(g.admit(tick('t1')).admitted).toBe(false);
  });

  it('caps each tenant on its own — a busy tenant does not refuse a quiet one', () => {
    const g = gate(1);
    expect(g.admit(tick('t1')).admitted).toBe(true);
    expect(g.admit(tick('t1')).admitted).toBe(false);
    expect(g.admit(tick('t2')).admitted).toBe(true);
  });

  it('never gates a tick that names no tenant', () => {
    // `worker_heartbeat` and `vault_credential_retention` are platform sweeps.
    // They are nobody's tenant work, so no tenant's budget pays for them.
    const g = gate(1);
    expect(g.admit(tick()).admitted).toBe(true);
    expect(g.admit(tick()).admitted).toBe(true);
    expect(g.inFlight(undefined)).toBe(0);
  });

  it('frees the slot on release, and only that tenant’s', () => {
    const g = gate(1);
    g.admit(tick('t1'));
    expect(g.admit(tick('t1')).admitted).toBe(false);
    g.release(tick('t1'));
    expect(g.admit(tick('t1')).admitted).toBe(true);
  });

  it('forgets a tenant once it is idle, so the map does not grow for ever', () => {
    const g = gate(1);
    g.admit(tick('t1'));
    g.release(tick('t1'));
    expect(g.tracked()).toBe(0);
  });

  it('returns a refused tick for republication, counting the deferral', () => {
    const g = gate(1);
    g.admit(tick('t1'));
    const result = g.admit(tick('t1'));
    expect(result.admitted).toBe(false);
    expect(result.retry).toEqual({ ...tick('t1'), deferrals: 1 });
    expect(result.afterMs).toBe(5000);
  });

  it('drops a tick that has been deferred too many times, rather than cycling it for ever', () => {
    // A tenant whose runs never finish would otherwise accumulate one
    // permanently circling message per missed occurrence.
    const g = gate(1);
    g.admit(tick('t1'));
    const result = g.admit(tick('t1', MAX_DEFERRALS));
    expect(result.admitted).toBe(false);
    expect(result.retry).toBeUndefined();
    expect(result.dropped).toContain('t1');
  });

  it('releasing something that was never admitted does not create a negative budget', () => {
    // The consumer releases in a `finally`, so a throw before the admit must
    // not hand the tenant a free slot.
    const g = gate(1);
    g.release(tick('t1'));
    expect(g.admit(tick('t1')).admitted).toBe(true);
    expect(g.admit(tick('t1')).admitted).toBe(false);
  });
});
