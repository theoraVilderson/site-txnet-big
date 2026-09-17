import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * `notification-service`'s connection to Postgres (F-035-a).
 *
 * The one generated client covers every schema; this service queries the
 * `notification` models and nothing else. It connects as `DATABASE_APP_URL`,
 * the app role, for the reason `billing-service`'s `PrismaService` gives.
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
