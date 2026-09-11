import { Module } from '@nestjs/common';
import { BotUpdateConsumer } from './bot-update.consumer';

/**
 * The third thing this process consumes (F-067-b), and the second that is not
 * a tick. It shares the broker with `AutomationModule` and nothing else — its
 * own queue set, no schedule, no `bot_worker` row.
 */
@Module({ providers: [BotUpdateConsumer] })
export class BotModule {}
