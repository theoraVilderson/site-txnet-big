import { Global, Module } from '@nestjs/common';
import { RealtimePublisher } from './realtime.publisher';

/**
 * The realtime fan-out's producing side (F-067-i).
 *
 * `@Global` for the same reason `RedisModule` is: any job or consumer in this
 * process may have finished work a user is waiting for, and a module list
 * that has to name each one is a list somebody forgets to extend. It holds one
 * provider and no connection of its own — the publish rides the Redis client
 * `RedisModule` already opened.
 */
@Global()
@Module({
  providers: [RealtimePublisher],
  exports: [RealtimePublisher],
})
export class RealtimeModule {}
