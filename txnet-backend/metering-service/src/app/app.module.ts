import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { BrokerModule } from './broker/broker.module';
import { envConfigOptions } from './config/env.validation';
import { MeteringModule } from './metering/metering.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [ConfigModule.forRoot(envConfigOptions), PrismaModule, BrokerModule, MeteringModule],
})
export class AppModule {}
