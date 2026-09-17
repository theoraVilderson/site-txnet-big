import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * `tenant-service`'s connection to Postgres (F-018-t, ADR-0058).
 *
 * The one generated client covers every schema; this service queries the
 * `tenant` models and nothing else. It connects as `DATABASE_APP_URL`, the app
 * role, for the reason `billing-service`'s `PrismaService` gives.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor(datasourceUrl: string) {
    super({ datasourceUrl });
  }

  async onModuleInit() {
    await this.$connect();
    this.logger.log('connected to database');
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
