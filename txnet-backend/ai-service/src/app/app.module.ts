import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { TenantStatusGuard } from '@txnet-backend/shared-core';

import { AttentionModule } from './attention/attention.module';
import { DecisionModule } from './decision/decision.module';
import { BrokerModule } from './broker/broker.module';
import { envConfigOptions } from './config/env.validation';
import { HealthController } from './health.controller';
import { PrismaModule } from './prisma/prisma.module';
import { ProfileModule } from './profile/profile.module';
import { RedisModule } from './redis/redis.module';
import { TriggersModule } from './triggers/triggers.module';

/**
 * ai-service (ADR-0109 point 2). No tenant route until F-038-j / F-1534 —
 * only `/health` and the service-only rebuild seam (F-038-c); the status
 * guard is registered now (C-11) because this app opens tenant scopes, so its
 * first tenant route is judged from day one.
 */
@Module({
  imports: [ConfigModule.forRoot(envConfigOptions), PrismaModule, RedisModule, BrokerModule, TriggersModule, ProfileModule, AttentionModule, DecisionModule],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: TenantStatusGuard }],
})
export class AppModule {}
