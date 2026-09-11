import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { envConfigOptions } from './config/env.validation';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { BrokerModule } from './broker/broker.module';
import { AutomationModule } from './automation/automation.module';
import { OtpModule } from './otp/otp.module';
import { BotModule } from './bot/bot.module';
import { RealtimeModule } from './realtime/realtime.module';

@Module({
  imports: [
    ConfigModule.forRoot(envConfigOptions),
    PrismaModule,
    RedisModule,
    RealtimeModule,
    BrokerModule,
    AutomationModule,
    OtpModule,
    BotModule,
  ],
})
export class AppModule {}
