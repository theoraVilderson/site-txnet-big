import { Injectable } from '@nestjs/common';
import { AuthBrokerPublisher } from './broker.publisher';

/**
 * The `admin_manual` tick (F-031-b, ADR-0027) — one of the two things this
 * request-serving process publishes.
 *
 * Everything about *how* it is published — the lazy connection, the awaited
 * confirm, the `mandatory` flag, the 503 on any of them failing — is
 * `AuthBrokerPublisher`'s, and was moved there by F-067-a when OTP delivery
 * became the second publisher here. What is left is this message.
 */
@Injectable()
export class ManualTickPublisher {
  constructor(private readonly broker: AuthBrokerPublisher) {}

  /**
   * Publish one `automation.tick.<key>` with `triggeredBy: 'admin_manual'`.
   *
   * The message shape is `worker-service`'s `TickMessage`, and it is written
   * out here rather than imported: the consumer lives in another Nx app, so
   * the wire between them is the exchange and the four fields on it. That is
   * the seam ADR-0027 chose, and a shared TypeScript type would not make the
   * two processes deploy together anyway.
   */
  async publishManualTick(key: string): Promise<void> {
    await this.broker.publishJson(
      `automation.tick.${key}`,
      {
        key,
        at: new Date().toISOString(),
        reason: 'an admin asked for a run',
        triggeredBy: 'admin_manual',
      },
      'the broker did not confirm the run request',
    );
  }
}
