import { MAX_DEFERRALS } from './tenant-concurrency.gate';
import { deadLetterRecordOf } from './dead-letter';

/**
 * F-067-d — **a message that ends is a message with a record.**
 *
 * The topology half of this item either connects or it does not: a queue
 * asserted with the wrong dead-letter argument fails on boot, loudly. What
 * fails *silently* is this function — the classification and the attempt count
 * written into the `dead_letter` row an operator later reads. A row that says
 * `handler_failed` about a tick the tenant gate gave up on, or that says
 * "attempt 1" about the twentieth, is worse than no row: it is a wrong answer
 * to the only question the table exists to answer.
 *
 * It is a pure function of one AMQP message for that reason — no broker and no
 * Postgres, the same shape `tenant-concurrency.gate.spec.ts` takes.
 */
describe('deadLetterRecordOf', () => {
  const tick = (extra: Record<string, unknown> = {}) => ({
    key: 'campaign_sender',
    at: '2026-09-10T10:00:00.000Z',
    reason: 'cron matched',
    triggeredBy: 'cron',
    ...extra,
  });

  const message = (
    content: string,
    headers: Record<string, unknown> = {},
    routingKey = 'automation.tick.campaign_sender',
  ) => ({
    routingKey,
    content: Buffer.from(content),
    headers,
  });

  /** What the broker itself adds when it dead-letters a message. */
  const xDeath = (count: number, queue = 'txnet.automation.ticks.v2') => ({
    'x-death': [{ count, reason: 'rejected', queue }],
  });

  it('keeps the worker key and the routing key the message arrived on', () => {
    const record = deadLetterRecordOf(message(JSON.stringify(tick())));

    expect(record.routingKey).toBe('automation.tick.campaign_sender');
    expect(record.workerKey).toBe('campaign_sender');
    expect(record.payload).toMatchObject({ key: 'campaign_sender' });
    // Nothing was unreadable, so there is no second copy of it.
    expect(record.rawPayload).toBeNull();
  });

  it('reads the worker key from the routing key when the body has none', () => {
    // A message from a future producer — an outbox event, a bot update — that
    // is not shaped like a tick. The routing key is the only address it has,
    // and losing it would make the row unattributable.
    const record = deadLetterRecordOf(
      message(JSON.stringify({ some: 'other producer' })),
    );

    expect(record.workerKey).toBe('campaign_sender');
    expect(record.reason).toBe('handler_failed');
  });

  it('preserves a body that is not JSON instead of dropping it', () => {
    const record = deadLetterRecordOf(message('<html>not a tick</html>'));

    expect(record.reason).toBe('unparseable');
    expect(record.payload).toBeNull();
    expect(record.rawPayload).toBe('<html>not a tick</html>');
    expect(record.workerKey).toBe('campaign_sender');
  });

  it('tells a tick the gate gave up on from one whose handler failed', () => {
    const gaveUp = deadLetterRecordOf(
      message(JSON.stringify(tick({ tenantId: 't1', deferrals: MAX_DEFERRALS }))),
    );
    const failed = deadLetterRecordOf(
      message(JSON.stringify(tick({ tenantId: 't1', deferrals: 3 }))),
    );

    expect(gaveUp.reason).toBe('gate_gave_up');
    expect(gaveUp.detail).toContain(`${MAX_DEFERRALS}`);
    expect(failed.reason).toBe('handler_failed');
  });

  it('counts the attempts the message carries, not the delivery in hand', () => {
    // `x-attempts` is stamped by every publish, so a tick the gate deferred
    // nineteen times arrives carrying twenty. Reporting 1 would make the
    // pathological case look like the ordinary one.
    const deferred = deadLetterRecordOf(
      message(JSON.stringify(tick({ deferrals: 19 })), {
        'x-attempts': 20,
        ...xDeath(1),
      }),
    );
    expect(deferred.attempts).toBe(20);

    // And when only the broker counted — a producer that stamps no header —
    // its count is the honest answer rather than a hardcoded 1.
    const brokerCounted = deadLetterRecordOf(
      message(JSON.stringify(tick()), xDeath(3)),
    );
    expect(brokerCounted.attempts).toBe(3);

    // Neither counter present: it was delivered once and it ended.
    expect(deadLetterRecordOf(message(JSON.stringify(tick()))).attempts).toBe(1);
  });

  it('says which queue the message died out of', () => {
    const record = deadLetterRecordOf(
      message(JSON.stringify(tick()), xDeath(1, 'txnet.automation.ticks.v2')),
    );

    expect(record.detail).toContain('txnet.automation.ticks.v2');
    expect(record.detail).toContain('rejected');
  });
});
