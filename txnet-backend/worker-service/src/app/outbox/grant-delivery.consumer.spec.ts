/**
 * The buyer's notice for a delivered or refunded purchase (F-111-d), and
 * where a delivered one is (F-601-h).
 *
 * What would break silently here, and nowhere else:
 *  - **"ready" says where**: a delivered Grant's `servicesUrl` — the tenant's
 *    own My services page, billing's to work out — is passed to the template,
 *    so the notice ends with it; a tenant with no panel address has none, and
 *    the notice reads whole without it;
 *  - **a refund carries no link**: only `amount`, whatever else the payload says;
 *  - **a purchase still waiting tells two people** (F-601-i): the buyer that
 *    it is being prepared, and the tenant's owner why — each under its own
 *    consumer name, so a redelivery repeats only the one that failed.
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
  const send = vi.fn(async (_notice: { consumer: string; person?: { userId: string; template: string; params: Record<string, string> } }) => undefined);
  (consumer as unknown as { notices: { send: typeof send } }).notices = { send };
  const person = () => (send.mock.calls[0] as unknown as [{ person: { template: string; params: Record<string, string> } }])[0].person;
  return { consumer, person, send };
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

describe('GrantDeliveryConsumer — a purchase still waiting (F-601-i)', () => {
  const OWNER = '55555555-5555-4555-8555-555555555551';
  const delayed = (payload: Record<string, unknown> = {}) =>
    event(OutboxEventType.GRANT_DELIVERY_DELAYED, { ownerUserId: OWNER, reason: 'panel_unavailable', waitingPanels: '2', ...payload });

  it('tells the buyer it is being prepared, and the owner why, each under its own marker', async () => {
    const { consumer, send } = build();
    await consumer.handle(delayed());

    const told = send.mock.calls.map(([n]) => ({ consumer: n.consumer, userId: n.person?.userId, template: n.person?.template, params: n.person?.params }));
    expect(told).toEqual([
      { consumer: 'grant-delivery-notify', userId: USER, template: 'purchaseDelayed', params: {} },
      { consumer: 'grant-delivery-alert', userId: OWNER, template: 'purchaseStuckPanelUnavailable', params: { panels: '2' } },
    ]);
  });

  it('names each reason with its own owner template', async () => {
    const { consumer, send } = build();
    await consumer.handle(delayed({ reason: 'write_unconfirmed' }));
    await consumer.handle(delayed({ reason: 'strategy_not_built' }));
    expect([send.mock.calls[1]![0].person?.template, send.mock.calls[3]![0].person?.template]).toEqual([
      'purchaseStuckWriteUnconfirmed',
      'purchaseStuckStrategyNotBuilt',
    ]);
  });

  it('still tells the owner when the buyer\'s send failed, then throws so the event is owed', async () => {
    const { consumer, send } = build();
    send.mockRejectedValueOnce(new Error('auth-service down'));
    await expect(consumer.handle(delayed())).rejects.toThrow('auth-service down');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('throws on a reason it has no words for, or a payload without its owner — before telling anyone', async () => {
    const { consumer, send } = build();
    await expect(consumer.handle(delayed({ reason: 'bored' }))).rejects.toThrow();
    await expect(consumer.handle(delayed({ ownerUserId: undefined }))).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
});
