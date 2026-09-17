import { UnscopedRedisKeys } from '@txnet-backend/shared-core';
import { TickMessage } from '../broker/broker.service';
import { Job } from './job';
import { TenantStatusGate } from './tenant-status.gate';

/**
 * F-018-p — **a tick that acts for one tenant runs only if that tenant's
 * status allows what the job does** (tenant invariant 17, `rules.md`).
 *
 * The HTTP guard never sees a tick, so without this a suspended reseller's
 * scheduled work would keep running. The store is faked as a map: what the
 * gate may assume of Redis is `get`, and nothing else.
 */
describe('TenantStatusGate', () => {
  const tick = (tenantId?: string): TickMessage => ({
    key: 'tenant_job',
    at: '2026-09-17T10:00:00.000Z',
    reason: 'cron matched',
    triggeredBy: 'cron',
    ...(tenantId ? { tenantId } : {}),
  });
  const job = (tenantCapability?: Job['tenantCapability']): Job => ({
    key: 'tenant_job',
    name: 'Tenant job',
    category: 'campaign' as Job['category'],
    ...(tenantCapability ? { tenantCapability } : {}),
    run: () => Promise.resolve({}),
  });
  const gateWith = (states: Record<string, string>) =>
    new TenantStatusGate({
      get: (key: string) =>
        Promise.resolve(
          Object.entries(states).find(([id]) => UnscopedRedisKeys.tenantStatus(id) === key)?.[1] ?? null,
        ),
    });
  const suspended = JSON.stringify({ status: 'suspended', graceEndsAt: '2026-09-24T10:00:00.000Z' });
  const terminated = JSON.stringify({ status: 'terminated', graceEndsAt: null });

  it('refuses an undeclared job for a suspended tenant — a job that says nothing is a staff write', async () => {
    expect(await gateWith({ t1: suspended }).allows(tick('t1'), job())).toBe(false);
  });

  it('runs a job that declares system even for a terminated tenant', async () => {
    expect(await gateWith({ t1: terminated }).allows(tick('t1'), job('system'))).toBe(true);
  });

  it('refuses a read job for a terminated tenant but runs it for a suspended one', async () => {
    const gate = gateWith({ t1: suspended, t2: terminated });
    expect(await gate.allows(tick('t1'), job('read'))).toBe(true);
    expect(await gate.allows(tick('t2'), job('read'))).toBe(false);
  });

  it('does not judge a platform tick, and a missing key refuses nobody', async () => {
    const gate = gateWith({ t1: terminated });
    expect(await gate.allows(tick(), job())).toBe(true);
    expect(await gate.allows(tick('unknown'), job())).toBe(true);
  });

  it('runs the tick when the store cannot be asked — the same trade as a missing key', async () => {
    const gate = new TenantStatusGate({ get: () => Promise.reject(new Error('redis is unreachable')) });
    expect(await gate.allows(tick('t1'), job())).toBe(true);
  });
});
