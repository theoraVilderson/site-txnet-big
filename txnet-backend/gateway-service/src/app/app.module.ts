import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { envConfigOptions } from './config/env.validation';
import { RedisModule } from './redis/redis.module';
import { RealtimeModule } from './realtime/realtime.module';
import { HealthController } from './health.controller';
import { JsonLoggerModule } from '@txnet-backend/shared-core';

@Module({
  imports: [
    ConfigModule.forRoot(envConfigOptions),
    JsonLoggerModule,
    RedisModule,
    RealtimeModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
