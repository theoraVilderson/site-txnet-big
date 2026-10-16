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

import { HomeNotices } from './home-notices';
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

/** `homes` maps a user to the tenant they live in; a user it does not name is not found. */
function build(homes: Record<string, string> = {}) {
  const config = { get: (_k: string, fallback?: unknown) => fallback };
  const findUnique = vi.fn(async ({ where }: { where: { id: string } }) => (homes[where.id] ? { tenantId: homes[where.id] } : null));
  const crossTenant = { user: { findUnique } };
  const home = new HomeNotices({} as never, {} as never, { publish: vi.fn() } as never, config as never, crossTenant as never);
  const consumer = new TenantSubscriptionNoticeConsumer({} as never, home);
  const send = vi.fn(async (_notice: { consumer: string; person?: { tenantId: string; userId: string; template: string; params: Record<string, string> } }) => undefined);
  (home as unknown as { notices: { send: typeof send } }).notices = { send };
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

describe("TenantSubscriptionNoticeConsumer — the person's own tenant (F-067-q)", () => {
  // A bought reseller's owner is a platform user: auth-service looks a person up
  // in the tenant it is told, and under the reseller's it found no one and sent
  // nothing (`sent: []`, no error). The consumer reads where the person lives.
  const PLATFORM = '99999999-9999-4999-8999-999999999999';
  const ADMIN = '55555555-5555-4555-8555-555555555555';

  it.each([
    ['renewal due', OutboxEventType.TENANT_SUBSCRIPTION_PAYMENT_DUE, { amount: '20.00' }],
    ['suspended', OutboxEventType.TENANT_SUBSCRIPTION_SUSPENDED, { amount: '20.00' }],
    ['zero balance', OutboxEventType.TENANT_WHOLESALE_UNFUNDED, {}],
    ['quota alert', OutboxEventType.TENANT_QUOTA_ALERT, { level: '80', mode: 'overage' }],
    ['quota digest', OutboxEventType.TENANT_QUOTA_DIGEST, { day: '2026-10-08' }],
    ['emergency entry', OutboxEventType.TENANT_EMERGENCY_ENTRY, {}],
    ['domain', OutboxEventType.TENANT_DOMAIN_NOTICE, { host: 'a.ir', outcome: 'live' }],
  ])("tells a platform owner of a reseller's %s in the platform's tenant", async (_label, type, payload) => {
    const { consumer, person } = build({ [OWNER]: PLATFORM });
    await consumer.handle(event(type, payload));
    expect(person()).toMatchObject({ tenantId: PLATFORM, userId: OWNER });
  });

  it('tells a wheel admin in their own tenant too', async () => {
    const { consumer, person } = build({ [ADMIN]: PLATFORM });
    await consumer.handle(event(OutboxEventType.TENANT_WHEEL_CAP_NEARING, { userId: ADMIN, day: '2026-10-08', spent: '8', cap: '10' }));
    expect(person()).toMatchObject({ tenantId: PLATFORM, userId: ADMIN, template: 'wheelCapNearing' });
  });

  it('tells each person who may confirm a transfer of its proof, with what the bot button opens (F-805-b)', async () => {
    const { consumer, person } = build({ [ADMIN]: TENANT });
    await consumer.handle(event(OutboxEventType.TRANSFER_PROOF_SENT, { userId: ADMIN, paymentId: 'p-1', amount: '12500000', currencyCode: 'IRR' }));
    expect(person()).toMatchObject({ tenantId: TENANT, userId: ADMIN, template: 'transferProofSent', params: { paymentId: 'p-1', amount: '12500000', currencyCode: 'IRR' } });
  });

  it('tells each of the staff about a user who costs more than they pay, with the figures to say it (F-1003)', async () => {
    const { consumer, person } = build({ [ADMIN]: TENANT });
    const payload = { userId: ADMIN, lossUserId: 'u-1', name: 'Sara', net: '100.00', cost: '130.50', currencyCode: 'IRT', percent: '20' };
    await consumer.handle(event(OutboxEventType.ANALYTICS_USER_LOSS, payload));
    expect(person()).toMatchObject({ tenantId: TENANT, userId: ADMIN, template: 'analyticsUserLoss', params: { name: 'Sara', net: '100.00', cost: '130.50', currencyCode: 'IRT', percent: '20' } });
  });

  it("keeps the event's tenant for an owner who lives in the reseller itself", async () => {
    const { consumer, person } = build({ [OWNER]: TENANT });
    await consumer.handle(event(OutboxEventType.TENANT_WHOLESALE_UNFUNDED));
    expect(person()).toMatchObject({ tenantId: TENANT });
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
