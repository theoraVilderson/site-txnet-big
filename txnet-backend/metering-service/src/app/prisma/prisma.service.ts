import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * `metering-service`'s connection to Postgres (F-027-n).
 *
 * The one generated client covers every schema; what this service queries is
 * `network` — `traffic_raw_log`, `usage_delta_seen`, `usage_delta_quarantine`,
 * `usage_hold`, `unattributed_usage`, `config` — and one column of
 * `entitlement.grant`, `consumedBytes`. That is the measured cursor and not the
 * money one (`entitlement/data-model.md`): this process makes usage visible and
 * charges nobody.
 *
 * `DATABASE_APP_URL` for the reason `auth-service`'s class gives: Row-Level
 * Security does not bind a table's owner, and the owner is what `DATABASE_URL`
 * is. There is no fallback to it — a fallback is a silent return to no
 * isolation at all, and this process writes one tenant's traffic in a loop over
 * every tenant's.
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
