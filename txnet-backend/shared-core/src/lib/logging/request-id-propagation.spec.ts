import { RequestHeaders } from '../http/headers';
import { serviceCallHeaders } from '../http/service-call';
import { outboxRequestIdQueryMap } from './outbox-request-id';
import { runWithRequestId } from './request-scope';

/**
 * H13: a request's id leaves the process with it — on every call to another
 * service and on every outbox event written while it is in scope — so one
 * Loki query by `requestId` follows the work across services.
 */
describe('serviceCallHeaders', () => {
  it('carries the service token and, inside a request, its id', () => {
    expect(serviceCallHeaders('tok')).toEqual({ [RequestHeaders.serviceToken]: 'tok' });
    expect(runWithRequestId('trace-0001', () => serviceCallHeaders('tok'))).toEqual({
      [RequestHeaders.serviceToken]: 'tok',
      [RequestHeaders.requestId]: 'trace-0001',
    });
  });
});

describe('outboxRequestIdQueryMap', () => {
  const { create, createMany } = outboxRequestIdQueryMap.outboxEvent;
  const passThrough = (args: unknown) => Promise.resolve(args);
  const event = { aggregate: 'billing.payment', aggregateId: 'p1', type: 'payment.confirmed', payload: {} };

  it('stamps the request id on an event written inside a request', async () => {
    const args = await runWithRequestId('trace-0001', () => create({ args: { data: { ...event } }, query: passThrough }));
    expect(args).toEqual({ data: { ...event, requestId: 'trace-0001' } });
  });

  it('stamps every row of a createMany, single or list', async () => {
    const list = await runWithRequestId('trace-0001', () => createMany({ args: { data: [{ ...event }, { ...event }] }, query: passThrough }));
    expect(list).toEqual({ data: [{ ...event, requestId: 'trace-0001' }, { ...event, requestId: 'trace-0001' }] });
    const single = await runWithRequestId('trace-0001', () => createMany({ args: { data: { ...event } }, query: passThrough }));
    expect(single).toEqual({ data: { ...event, requestId: 'trace-0001' } });
  });

  it('leaves an event alone outside a request, and keeps an id the writer chose', async () => {
    expect(await create({ args: { data: { ...event } }, query: passThrough })).toEqual({ data: event });
    const chosen = await runWithRequestId('trace-0001', () =>
      create({ args: { data: { ...event, requestId: 'trace-0009' } }, query: passThrough }),
    );
    expect(chosen).toEqual({ data: { ...event, requestId: 'trace-0009' } });
  });
});
