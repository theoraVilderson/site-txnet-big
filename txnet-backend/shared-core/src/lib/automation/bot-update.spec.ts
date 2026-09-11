import {
  AUTOMATION_EXCHANGE_DEFAULT,
  BOT_UPDATE_ROUTING_PREFIX,
  botUpdateQueueName,
  botUpdateRoutingKey,
  botUpdateSlot,
} from './bot-update';

/**
 * F-067-b — the addressing that makes per-chat ordering a property of the
 * topology (D-16).
 *
 * This is the one thing in the feature that breaks **silently**. Everything
 * else fails loudly: an unpublished update is a 5xx the platform retries, an
 * unconsumed queue is a depth alert (F-067-g). But a slot function that
 * disagrees between the publisher in `bot-service` and the queue set asserted
 * by `worker-service`, or that is not stable for one chat, produces a system
 * that works — updates are handled, nothing errors — while two messages from
 * one conversation are handled at once by two consumers. The symptom is a
 * flow that answers step 3 before step 2, weeks later, under load.
 *
 * So the properties, not the hash: one chat always lands on one slot, every
 * slot is a real queue, and the routing key a publisher writes is the one the
 * consumer's queue is bound to.
 */
describe('bot update addressing', () => {
  const QUEUES = 4;

  it('sends one chat to one slot, every time', () => {
    const first = botUpdateSlot('5501', QUEUES);
    for (let i = 0; i < 50; i++) {
      expect(botUpdateSlot('5501', QUEUES)).toBe(first);
    }
  });

  it('stays inside the queue set for anything a messenger can call a chat', () => {
    const chats = [
      '0',
      '5501',
      '-1001234567890', // a Telegram supergroup id, negative
      'ب-۱۲۳', // non-ASCII: nothing normalises a chat id before this
      'x'.repeat(512),
    ];
    for (const chat of chats) {
      const slot = botUpdateSlot(chat, QUEUES);
      expect(Number.isInteger(slot)).toBe(true);
      expect(slot).toBeGreaterThanOrEqual(0);
      expect(slot).toBeLessThan(QUEUES);
    }
  });

  it('spreads chats across the whole set rather than piling them on one queue', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) seen.add(botUpdateSlot(`chat-${i}`, QUEUES));
    expect(seen.size).toBe(QUEUES);
  });

  it('addresses the queue the publisher is publishing to', () => {
    // The two halves of the wire: `bot-service` writes a routing key,
    // `worker-service` binds a queue name to it. A change to either that is
    // not a change to both is the failure this pair is here to catch.
    const slot = botUpdateSlot('5501', QUEUES);
    expect(botUpdateRoutingKey('5501', QUEUES)).toBe(
      `${BOT_UPDATE_ROUTING_PREFIX}${slot}`,
    );
    expect(botUpdateQueueName('txnet.automation.bot.update', slot)).toBe(
      `txnet.automation.bot.update.${slot}`,
    );
  });

  it('refuses a queue count that cannot address anything', () => {
    // A misconfigured count must not silently become "one queue" — that is
    // the ordering guarantee holding while all parallelism is gone, which is
    // the failure nobody reports until the bot is slow.
    expect(() => botUpdateSlot('5501', 0)).toThrow();
    expect(() => botUpdateSlot('5501', -1)).toThrow();
    expect(() => botUpdateSlot('5501', 2.5)).toThrow();
  });
});

/**
 * F-079. The exchange name was defaulted independently in three zod schemas and
 * a fourth time in compose. A publisher and a consumer that disagree about it
 * both start cleanly and both report healthy, while the broker drops every
 * message with no error on either side — the same silent class of failure the
 * routing-key hash above lives here to prevent, one level up.
 */
describe('AUTOMATION_EXCHANGE_DEFAULT', () => {
  it('is the name the whole platform defaults to', () => {
    expect(AUTOMATION_EXCHANGE_DEFAULT).toBe('txnet.automation');
  });

  it('is the prefix the bot-update routing keys hang beneath', () => {
    // Not a coincidence worth leaving unstated: the queue names are
    // `<exchange>.bot.update.<slot>`, so an exchange rename that did not carry
    // the queues with it would bind the right consumer to the wrong address.
    expect(botUpdateQueueName(`${AUTOMATION_EXCHANGE_DEFAULT}.bot.update`, 0)).toBe(
      'txnet.automation.bot.update.0',
    );
  });
});
