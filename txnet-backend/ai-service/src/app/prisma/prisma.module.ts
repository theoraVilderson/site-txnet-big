import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { withTenant } from '@txnet-backend/shared-core';

import type { EnvConfig } from '../config/env.validation';
import { AiReaderPrisma, PrismaService } from './prisma.service';

/** The writer and the reader, both bound to the ambient tenant (ADR-0024). */
@Global()
@Module({
  providers: [
    {
      provide: PrismaService,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvConfig, true>) => {
        const base = new PrismaService(config.get('DATABASE_APP_URL', { infer: true }), 'writer');
        return base.$extends(withTenant(base)) as unknown as PrismaService;
      },
    },
    {
      provide: AiReaderPrisma,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvConfig, true>) => {
        const base = new AiReaderPrisma(config.get('DATABASE_AI_READER_URL', { infer: true }), 'reader');
        return base.$extends(withTenant(base)) as unknown as AiReaderPrisma;
      },
    },
  ],
  exports: [PrismaService, AiReaderPrisma],
})
export class PrismaModule {}
