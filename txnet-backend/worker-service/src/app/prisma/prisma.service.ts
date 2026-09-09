import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * `worker-service`'s connection to Postgres.
 *
 * The same role `auth-service` connects as, and for the same reason
 * (F-066-m-a): `DATABASE_URL` is the superuser that owns the tables, so Row-
 * Level Security is inert against it. There is no fallback.
 *
 * It is deliberately **not** the `$extends`-ed client `auth-service` builds.
 * `withTenant` demands an ambient tenant for every registered model, and this
 * process has none: a tick is platform work, not a request, and `bot_worker`,
 * `bot_schedule` and `bot_execution_log` carry no `tenantId` column at all. A
 * job that does need a tenant scope opens one itself, which is a decision for
 * the row that adds that job rather than for the substrate.
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
