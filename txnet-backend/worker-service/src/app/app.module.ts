import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { envConfigOptions } from './config/env.validation';
import { PrismaModule } from './prisma/prisma.module';
import { BrokerModule } from './broker/broker.module';
import { AutomationModule } from './automation/automation.module';

@Module({
  imports: [
    ConfigModule.forRoot(envConfigOptions),
    PrismaModule,
    BrokerModule,
    AutomationModule,
  ],
})
export class AppModule {}
