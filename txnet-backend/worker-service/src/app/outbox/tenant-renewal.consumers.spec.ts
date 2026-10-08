/**
 * The reseller owner's notices (F-019-c, F-118-w).
 *
 * What would break silently here, and nowhere else:
 *  - **a reseller at zero is told** (F-118-w): `tenant.billing.wholesale_unfunded`
 *    carries no amount, and must reach the owner as `resellerWholesaleUnfunded`
 *    rather than be refused as "a renewal notice without its amount";
 *  - **a renewal notice still needs its amount**: payment due and suspended
 *    keep their templates and params;
 *  - **no owner, no notice**: a payload without its tenant or owner throws, so
 *    the event dead-letters instead of telling nobody.
 */
import { OutboxEventType, type OutboxMessage } from '@txnet-backend/shared-core';

import { TenantSubscriptionNoticeConsumer } from './tenant-renewal.consumers';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OWNER = '44444444-4444-4444-8444-444444444444';

function event(type: string, payload: Record<string, unknown> = {}): OutboxMessage {
  return {
    id: '88888888-8888-4888-8888-888888888888',
    aggregate: 'tenant.billing',
    aggregateId: TENANT,
    type,
    occurredAt: '2026-09-30T10:00:00Z',
    payload: { tenantId: TENANT, ownerUserId: OWNER, ...payload },
  };
}

function build() {
  const config = { get: (_k: string, fallback?: unknown) => fallback };
  const consumer = new TenantSubscriptionNoticeConsumer({} as never, {} as never, { publish: vi.fn() } as never, config as never);
  const send = vi.fn(async (_notice: { consumer: string; person?: { tenantId: string; userId: string; template: string; params: Record<string, string> } }) => undefined);
  (consumer as unknown as { notices: { send: typeof send } }).notices = { send };
  const person = () => (send.mock.calls[0] as unknown as [{ person: { tenantId: string; userId: string; template: string; params: Record<string, string> } }])[0].person;
  return { consumer, person, send };
}

describe('TenantSubscriptionNoticeConsumer — a reseller at zero (F-118-w)', () => {
  it('tells the owner its users on platform panels are cut, with no amount needed', async () => {
    const { consumer, person, send } = build();
    await consumer.handle(event(OutboxEventType.TENANT_WHOLESALE_UNFUNDED, { period: '2026-09-30T10:00:00.000Z' }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(person()).toEqual({ tenantId: TENANT, userId: OWNER, template: 'resellerWholesaleUnfunded', params: {} });
  });

  it('refuses a payload without its owner, so the event dead-letters', async () => {
    const { consumer, send } = build();
    await expect(consumer.handle(event(OutboxEventType.TENANT_WHOLESALE_UNFUNDED, { ownerUserId: '' }))).rejects.toThrow(/tenant or owner/);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('TenantSubscriptionNoticeConsumer — an emergency entry (F-117-d)', () => {
  it("tells the owner the platform entered without its consent, and nothing of the staff member's words", async () => {
    const { consumer, person } = build();
    await consumer.handle(event(OutboxEventType.TENANT_EMERGENCY_ENTRY, { entryId: 'e-1', expiresAt: '2026-09-30T11:00:00.000Z' }));
    expect(person()).toEqual({ tenantId: TENANT, userId: OWNER, template: 'resellerEmergencyEntry', params: {} });
  });
});

describe('TenantSubscriptionNoticeConsumer — a custom domain (RT-1-e2)', () => {
  it.each([
    ['live', 'resellerDomainLive'],
    ['failed', 'resellerDomainFailed'],
    ['dropped', 'resellerDomainDropped'],
  ])('tells the owner a domain %s, naming the host', async (outcome, template) => {
    const { consumer, person } = build();
    await consumer.handle(event(OutboxEventType.TENANT_DOMAIN_NOTICE, { host: 'panel.barghgho.ir', outcome }));
    expect(person()).toEqual({ tenantId: TENANT, userId: OWNER, template, params: { host: 'panel.barghgho.ir' } });
  });

  it("tells the owner in its own tenant, not the reseller's: a bought reseller's owner is a platform user", async () => {
    const { consumer, person } = build();
    await consumer.handle(event(OutboxEventType.TENANT_DOMAIN_NOTICE, { host: 'a.ir', outcome: 'live', ownerTenantId: 'platform-1' }));
    expect(person()).toMatchObject({ tenantId: 'platform-1', userId: OWNER });
  });

  it('refuses an outcome it has no words for, so the event dead-letters', async () => {
    const { consumer, send } = build();
    await expect(consumer.handle(event(OutboxEventType.TENANT_DOMAIN_NOTICE, { host: 'a.ir', outcome: 'odd' }))).rejects.toThrow(/domain notice/);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('TenantSubscriptionNoticeConsumer — renewal notices (F-019-c)', () => {
  it('passes a payment due its amount, balance and suspension date', async () => {
    const { consumer, person } = build();
    await consumer.handle(event(OutboxEventType.TENANT_SUBSCRIPTION_PAYMENT_DUE, { amount: '20.00', balance: '3.00', suspendsAt: '2026-10-03' }));
    expect(person()).toMatchObject({ template: 'subscriptionPaymentDue', params: { amount: '20.00', balance: '3.00', suspendsAt: '2026-10-03' } });
  });

  it('passes a suspension its amount alone', async () => {
    const { consumer, person } = build();
    await consumer.handle(event(OutboxEventType.TENANT_SUBSCRIPTION_SUSPENDED, { amount: '20.00' }));
    expect(person()).toMatchObject({ template: 'subscriptionSuspended', params: { amount: '20.00' } });
  });

  it('still refuses a renewal notice without its amount', async () => {
    const { consumer } = build();
    await expect(consumer.handle(event(OutboxEventType.TENANT_SUBSCRIPTION_SUSPENDED))).rejects.toThrow(/amount/);
  });
});
