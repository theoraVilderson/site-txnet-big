import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { BrokerModule } from './broker/broker.module';
import { envConfigOptions } from './config/env.validation';
import { MeteringModule } from './metering/metering.module';
import { PrismaModule } from './prisma/prisma.module';
import { JsonLoggerModule } from '@txnet-backend/shared-core';

@Module({
  imports: [ConfigModule.forRoot(envConfigOptions), JsonLoggerModule, PrismaModule, BrokerModule, MeteringModule],
})
export class AppModule {}
