import { Injectable } from '@nestjs/common';
import { AuthBrokerPublisher } from '../../automation/broker.publisher';
import { OtpDeliveryRequest } from './otp.interface';

/** The routing key an OTP send is published under. Bound by `worker-service`. */
export const OTP_DELIVERY_ROUTING_KEY = 'otp.delivery.send';

/**
 * Publishes the request to send one OTP (F-067-a).
 *
 * It rides the same topic exchange as `automation.tick.#` rather than an
 * exchange of its own. One platform exchange with routing keys is what a topic
 * exchange is for, and the alternative buys a second thing to declare, to
 * monitor (F-067-g) and to dead-letter (F-067-d) in exchange for nothing —
 * F-067-b's bot updates and F-067-c's outbox events will be the third and
 * fourth key on it.
 *
 * A publish that is not confirmed fails the route with a 503 (D-18), which
 * makes the broker a hard dependency of *OTP* login. Password login is
 * untouched, and `OTP_DELIVERY_MODE=console` never reaches here at all — a dev
 * machine with no broker still registers and logs in.
 */
@Injectable()
export class OtpDeliveryPublisher {
  constructor(private readonly broker: AuthBrokerPublisher) {}

  async publishDelivery(request: OtpDeliveryRequest): Promise<void> {
    await this.broker.publishJson(
      OTP_DELIVERY_ROUTING_KEY,
      request,
      'otp.deliveryUnavailable',
    );
  }
}
