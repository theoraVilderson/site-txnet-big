/**
 * F-067-b — **where a bot update goes, so that a chat stays in order.**
 *
 * The webhook stopped running the conversation and now publishes it (D-16).
 * That buys the platform its 200 back, and it costs the one guarantee running
 * the flow inline gave away for free: two updates from the same chat used to
 * be handled one after another because there was one request handler and it
 * was awaited. On a queue with N consumers they are handled at once, and a
 * conversation whose step 3 is answered before its step 2 is a conversation
 * that has lost its state.
 *
 * **A routing key per chat over a fixed queue set**, rather than a shared
 * queue with a Redis lock per chat. A locked-out update has to go back on the
 * queue, which is the ordering problem again with a lock in front of it; here
 * ordering is a property of the topology — one chat's updates only ever reach
 * one queue, and that queue has one consumer holding one unacked message at a
 * time. Parallelism is then the number of queues, which is a number an
 * operator sets rather than a rewrite.
 *
 * **It lives in `shared-core` because it is an algorithm two apps must agree
 * on**, which is what makes it different from `TickMessage` and
 * `OtpDeliveryMessage` — those are field names, and a mismatch there is a
 * `undefined` somebody notices. `bot-service` computes the routing key,
 * `worker-service` asserts and binds the queues, and a hash that drifted
 * between the two would still deliver every message: to the wrong queue, in
 * the wrong order, with nothing failing. `confirm-publish.ts` is here for the
 * same reason and `schedule.ts` before it.
 */

/** Every bot-update routing key starts with this. The suffix is the slot. */
export const BOT_UPDATE_ROUTING_PREFIX = 'bot.update.';

/**
 * Which queue of the set this chat's updates belong to.
 *
 * FNV-1a over the id's UTF-16 code units: a chat id is a `string` here because
 * Telegram's is a number, Bale's is a number, and neither is one this platform
 * ever does arithmetic on — it is an address. The hash is written out rather
 * than taken from a dependency precisely because both apps must compute the
 * same one for ever; a library that changed its mixing constants in a minor
 * release would re-shard every live conversation on the next `npm install`.
 *
 * `queues` must be a positive integer. A zero or a fraction arriving from a
 * misread environment variable would otherwise produce `NaN`, and `NaN` names
 * a queue nobody bound — every update would be unroutable, which the
 * `mandatory` publish would at least make loud, but the honest failure is
 * here, at the boot that misconfigured it.
 */
export function botUpdateSlot(chatId: string, queues: number): number {
  if (!Number.isInteger(queues) || queues < 1) {
    throw new Error(
      `bot update queue count must be a positive integer, got ${queues}`,
    );
  }

  let hash = 0x811c9dc5;
  for (let i = 0; i < chatId.length; i++) {
    hash ^= chatId.charCodeAt(i);
    // The FNV prime, by shifts: a plain `hash * 16777619` overflows a double's
    // exact-integer range and stops being the same function on long inputs.
    hash +=
      (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    hash >>>= 0;
  }
  return hash % queues;
}

/** The key `bot-service` publishes one chat's update to. */
export function botUpdateRoutingKey(chatId: string, queues: number): string {
  return `${BOT_UPDATE_ROUTING_PREFIX}${botUpdateSlot(chatId, queues)}`;
}

/**
 * The queue `worker-service` binds to that key.
 *
 * One queue per slot rather than one queue with a wildcard binding: the point
 * of the set is that each queue has exactly one consumer, and a single queue
 * bound to `bot.update.#` would put every chat back in one line.
 */
export function botUpdateQueueName(prefix: string, slot: number): string {
  return `${prefix}.${slot}`;
}

/**
 * The AMQP exchange every automation message rides (F-079, ADR-0036).
 *
 * **One default, not three.** `txnet.automation` was defaulted independently in
 * `auth-service`, `bot-service` and `worker-service`'s zod schemas, plus a
 * fourth time in `docker-compose.main.yml`. An exchange name is an address two
 * processes have to agree on, and the failure is the quietest one in this file:
 * a publisher on `txnet.automation` and a consumer on anything else both start
 * cleanly, both report healthy, and every message is dropped by the broker with
 * no error on either side. It is exactly the class of bug
 * `BOT_UPDATE_ROUTING_PREFIX` and `botUpdateQueueName` already live here to
 * prevent, one level up.
 *
 * `AUTOMATION_EXCHANGE` still overrides it — the point is that an environment
 * that sets nothing gets one answer rather than three that happen to match.
 */
export const AUTOMATION_EXCHANGE_DEFAULT = 'txnet.automation';
