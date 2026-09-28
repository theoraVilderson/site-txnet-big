import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * `currency-service`'s connection to Postgres (ADR-0100), as
 * `DATABASE_APP_URL` — the app role, `NOBYPASSRLS`. The `currency` schema has
 * no row policy (its rows are no tenant's), so this one pool reads and writes
 * it; a tenant's own rows, when F-116-j adds them, are scoped by the tenant
 * the request carries.
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
