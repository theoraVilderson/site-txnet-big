import {
  PublishNotConfirmedError,
  confirmedPublisher,
  type ConfirmingChannel,
} from './confirm-publish';

/**
 * F-067-f — **a publish that was not confirmed is not a success.**
 *
 * The failure this states is the silent one. AMQP does not answer a plain
 * publish, so a broker that took the frame and dropped it — full disk, a queue
 * over its limit, a node failing over — is indistinguishable from one that
 * stored it, and the caller is told it worked either way. For a tick that costs
 * an interval; for the OTP send F-067-a puts on this broker it costs a user a
 * code that was never queued.
 *
 * It is a plain function of a channel-shaped object for the same reason
 * `dead-letter.spec.ts` is a plain function of a message: what must be true is
 * which answers count as delivery, and that needs no broker to say.
 */
describe('confirmedPublisher', () => {
  /**
   * A fake channel that hands out the confirm callbacks instead of calling
   * them, so each test decides how the broker answered — including by not
   * answering at all.
   */
  const channel = () => {
    const confirms: Array<(err: Error | null) => void> = [];
    const returns: Array<(message: { properties: { messageId?: string } }) => void> = [];
    const sent: Array<{
      exchange: string;
      routingKey: string;
      content: Buffer;
      options: Record<string, unknown>;
    }> = [];

    const fake: ConfirmingChannel = {
      publish(exchange, routingKey, content, options, callback) {
        sent.push({ exchange, routingKey, content, options });
        confirms.push(callback);
        return true;
      },
      on(event, listener) {
        if (event === 'return') returns.push(listener);
        return fake;
      },
    };

    return {
      fake,
      sent,
      /** Answer one publish, newest by default. Confirms are per message. */
      ack: (index = confirms.length - 1) => confirms[index](null),
      nack: (message = 'NACK', index = confirms.length - 1) =>
        confirms[index](new Error(message)),
      /** What the broker does to an unroutable mandatory message. */
      returnMessage: (messageId?: string) => {
        for (const listener of returns) listener({ properties: { messageId } });
      },
    };
  };

  const body = () => Buffer.from(JSON.stringify({ key: 'heartbeat' }));

  const reasonOf = async (promise: Promise<void>) => {
    try {
      await promise;
      return 'resolved';
    } catch (err) {
      return err instanceof PublishNotConfirmedError ? err.reason : 'other';
    }
  };

  it('resolves only once the broker has acked that message', async () => {
    const c = channel();
    const publish = confirmedPublisher(c.fake, 1_000);

    let settled = false;
    const sending = publish('txnet.automation', 'automation.tick.heartbeat', body()).then(
      () => {
        settled = true;
      },
    );

    // The frame is out and nothing has answered it yet. A publisher that
    // resolved here is the bug this whole item is about.
    expect(c.sent).toHaveLength(1);
    expect(settled).toBe(false);

    c.ack();
    await sending;
    expect(settled).toBe(true);
  });

  it('publishes as mandatory, and with an id the return listener can match', async () => {
    const c = channel();
    const publish = confirmedPublisher(c.fake, 1_000);

    const sending = publish('txnet.automation', 'automation.tick.heartbeat', body(), {
      persistent: true,
    });

    expect(c.sent[0].options['mandatory']).toBe(true);
    expect(c.sent[0].options['persistent']).toBe(true);
    expect(typeof c.sent[0].options['messageId']).toBe('string');

    c.ack();
    await sending;
  });

  it('rejects with `nacked` when the broker refuses the message', async () => {
    const c = channel();
    const publish = confirmedPublisher(c.fake, 1_000);

    const sending = publish('txnet.automation', 'automation.tick.heartbeat', body());
    c.nack('queue is full');

    await expect(reasonOf(sending)).resolves.toBe('nacked');
  });

  it('rejects with `unroutable` when the message comes back before the ack', async () => {
    const c = channel();
    const publish = confirmedPublisher(c.fake, 1_000);

    const sending = publish('txnet.automation', 'automation.tick.heartbeat', body());
    // RabbitMQ sends basic.return before the basic.ack, so the id is already
    // known by the time the confirm arrives — and the confirm *is* an ack. An
    // exchange with no binding is the case `auth-service` hits before
    // `worker-service` has ever asserted the queue.
    c.returnMessage(c.sent[0].options['messageId'] as string);
    c.ack();

    await expect(reasonOf(sending)).resolves.toBe('unroutable');
  });

  it('leaves another message in flight alone when one is returned', async () => {
    const c = channel();
    const publish = confirmedPublisher(c.fake, 1_000);

    const first = publish('txnet.automation', 'automation.tick.heartbeat', body());
    const firstId = c.sent[0].options['messageId'] as string;
    const second = publish('txnet.automation', 'automation.tick.vault', body());

    c.returnMessage(firstId);
    c.ack(1);
    await expect(reasonOf(second)).resolves.toBe('resolved');

    // The broker acks an unroutable message too — the return is the only thing
    // that says it went nowhere, so the ack must not clear the first one.
    c.ack(0);
    await expect(reasonOf(first)).resolves.toBe('unroutable');
  });

  it('rejects with `timeout` when the broker never answers', async () => {
    jest.useFakeTimers();
    try {
      const c = channel();
      const publish = confirmedPublisher(c.fake, 5_000);

      const sending = reasonOf(
        publish('txnet.automation', 'automation.tick.heartbeat', body()),
      );
      jest.advanceTimersByTime(5_000);

      await expect(sending).resolves.toBe('timeout');
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not leave a timer running once the broker has answered', async () => {
    jest.useFakeTimers();
    try {
      const c = channel();
      const publish = confirmedPublisher(c.fake, 5_000);

      const sending = publish('txnet.automation', 'automation.tick.heartbeat', body());
      c.ack();
      await sending;

      // A timer left pending would hold a shutting-down process open, which is
      // why `defer` in the tick consumer unrefs its own.
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
