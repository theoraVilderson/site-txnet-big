import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * `billing-service`'s connection to Postgres (F-092-a).
 *
 * The one generated client covers every schema (`prisma/domains/`,
 * `multiSchema`); what makes this billing's is that it only ever queries the
 * `billing` models. It connects as `DATABASE_APP_URL` for the reason
 * `auth-service`'s `PrismaService` gives: Row-Level Security does not bind a
 * table's owner, and the owner is what `DATABASE_URL` is. There is no fallback
 * to it.
 *
 * There is no cross-tenant pool here. That one exists in `auth-service` for the
 * reads that *resolve* a tenant; this service never resolves one — the gate
 * forwards it.
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
