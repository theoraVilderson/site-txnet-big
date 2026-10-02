import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * One Postgres pool. `ai-service` holds two (ADR-0109 point 6), told apart by
 * their tokens in `prisma.module.ts`: the writer on the app role, and the
 * reader on `txnet_ai_reader_user`.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger: Logger;

  constructor(datasourceUrl: string, name = 'writer') {
    super({ datasourceUrl });
    this.logger = new Logger(`${PrismaService.name}:${name}`);
  }

  async onModuleInit() {
    await this.$connect();
    this.logger.log('connected to database');
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}

/**
 * The reader pool. A distinct class so it cannot be injected where the writer
 * is meant. Its role holds SELECT on named tables and, on `identity.user`,
 * named columns only — so read with an explicit `select` or raw SQL; a
 * whole-row `findMany` there is refused by Postgres.
 */
@Injectable()
export class AiReaderPrisma extends PrismaService {}
