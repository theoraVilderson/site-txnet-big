import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { BrokerModule } from './broker/broker.module';
import { envConfigOptions } from './config/env.validation';
import { HealthController } from './health.controller';
import { PrismaModule } from './prisma/prisma.module';
import { TriggersModule } from './triggers/triggers.module';

/** ai-service (ADR-0109 point 2). No route but `/health` until F-038-j / F-1534. */
@Module({
  imports: [ConfigModule.forRoot(envConfigOptions), PrismaModule, BrokerModule, TriggersModule],
  controllers: [HealthController],
})
export class AppModule {}
