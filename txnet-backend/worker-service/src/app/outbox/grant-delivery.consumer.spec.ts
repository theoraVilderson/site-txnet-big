/**
 * The buyer's notice for a delivered or refunded purchase (F-111-d), and
 * where a delivered one is (F-601-h).
 *
 * What would break silently here, and nowhere else:
 *  - **"ready" says where**: a delivered Grant's `servicesUrl` — the tenant's
 *    own My services page, billing's to work out — is passed to the template,
 *    so the notice ends with it; a tenant with no panel address has none, and
 *    the notice reads whole without it;
 *  - **a refund carries no link**: only `amount`, whatever else the payload says.
 */
import { OutboxEventType, type OutboxMessage } from '@txnet-backend/shared-core';

import { GrantDeliveryConsumer } from './grant-delivery.consumer';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '44444444-4444-4444-8444-444444444444';
const GRANT = '99999999-9999-4999-8999-999999999991';
const URL = 'https://vpn.example/services';

function event(type: string, payload: Record<string, unknown> = {}): OutboxMessage {
  return {
    id: '88888888-8888-4888-8888-888888888888',
    aggregate: 'entitlement.grant',
    aggregateId: GRANT,
    type,
    occurredAt: '2026-09-27T10:00:00Z',
    payload: { tenantId: TENANT, userId: USER, grantId: GRANT, invoiceId: null, ...payload },
  };
}

function build() {
  const config = { get: (_k: string, fallback?: unknown) => fallback };
  const consumer = new GrantDeliveryConsumer({} as never, {} as never, { publish: vi.fn() } as never, config as never);
  const send = vi.fn(async () => undefined);
  (consumer as unknown as { notices: { send: typeof send } }).notices = { send };
  const person = () => (send.mock.calls[0] as unknown as [{ person: { template: string; params: Record<string, string> } }])[0].person;
  return { consumer, person };
}

describe('GrantDeliveryConsumer — where a delivered service is (F-601-h)', () => {
  it('passes a delivered Grant\'s servicesUrl to the template', async () => {
    const { consumer, person } = build();
    await consumer.handle(event(OutboxEventType.GRANT_DELIVERED, { servicesUrl: URL }));
    expect(person()).toMatchObject({ template: 'purchaseDelivered', params: { servicesUrl: URL } });
  });

  it('tells a delivered Grant without one whole, with no link param', async () => {
    const { consumer, person } = build();
    await consumer.handle(event(OutboxEventType.GRANT_DELIVERED));
    expect(person().params).toEqual({});
  });

  it('never gives a refund a link', async () => {
    const { consumer, person } = build();
    await consumer.handle(event(OutboxEventType.GRANT_REFUNDED, { amount: '12.50', servicesUrl: URL }));
    expect(person()).toMatchObject({ template: 'purchaseRefunded', params: { amount: '12.50' } });
    expect(person().params).not.toHaveProperty('servicesUrl');
  });
});
