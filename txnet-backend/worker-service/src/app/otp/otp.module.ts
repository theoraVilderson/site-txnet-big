import { Module } from '@nestjs/common';
import { OtpDeliveryConsumer } from './otp-delivery.consumer';

/**
 * The second thing this process consumes (F-067-a), and the first that is not
 * a tick. It shares the broker with `AutomationModule` and nothing else —
 * different queue, no schedule, no `bot_worker` row.
 */
@Module({ providers: [OtpDeliveryConsumer] })
export class OtpModule {}
