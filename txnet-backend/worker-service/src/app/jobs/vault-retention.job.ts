import { RequestHeaders } from '@txnet-backend/shared-core';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotWorkerCategory } from '@prisma/client';
import { Job, JobResult } from '../automation/job';

/** The one route this job exists to call. Service callers only; 404 otherwise. */
const DESTROY_EXPIRED_PATH = '/api/internal/vault/destroy-expired';

/**
 * The first real background job (F-031-c), and the thing that closes
 * ADR-0026 rule 4: **a superseded credential version stays verifiable for its
 * rotation grace window and is then destroyed.**
 *
 * `CredentialVaultService.destroyExpiredVersions` has existed since F-066-f
 * with no caller, so until now the second half of that rule was documented and
 * not done — a rotated secret's old version sat in the database for ever. That
 * is a retention gap rather than a disclosure one (the row is still sealed
 * under the tenant's DEK), which is why it could wait for a scheduler; it is
 * not a reason for it to keep waiting now that one exists.
 *
 * **Why this is an HTTP call and not a method call.** The vault is `tenant`'s
 * code and it lives inside `auth-service`; an Nx application cannot import
 * another Nx application. The two ways out were to move the vault into a
 * workspace library or to reach it over the internal seam, and this is the
 * seam — the same `ServiceOnlyGuard` + `SERVICE_AUTH_TOKEN` door F-066-i built
 * for `bot-service` (`interfaces/auth-api/contract.md`). A library move would
 * drag the vault's Prisma models, its KEK service and its audit trail across an
 * app boundary to serve one caller, and the vault's own contract says the
 * obligation to *schedule* this belongs to `automation` — not that the code
 * has to live here.
 *
 * **Safe to run twice** (the `Job` contract): destroying a row that is already
 * gone deletes nothing and answers 0.
 *
 * **It never succeeds quietly.** An unset token, a guard's 404 and an
 * unrecognised answer are each indistinguishable from "nothing was due" if
 * this returns a count of zero — and a sweep that reports health while
 * sweeping nothing is worse than one that is switched off, because an operator
 * reading `bot_execution_log` would have no way to tell. Every one of those
 * throws instead, and `TickConsumer` records it as a `failed` run
 * (automation invariant #3). See `vault-retention.job.spec.ts`.
 */
@Injectable()
export class VaultRetentionJob implements Job {
  readonly key = 'vault_credential_retention';
  readonly name = 'Vault credential retention';
  readonly description =
    'Destroys superseded credential versions past their rotation grace window (ADR-0026 rule 4).';
  readonly category = BotWorkerCategory.other;

  private readonly logger = new Logger(VaultRetentionJob.name);
  private readonly baseUrl: string;
  private readonly serviceToken: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.baseUrl = config
      .get<string>('AUTH_API_BASE_URL', '')
      .replace(/\/+$/, '');
    this.serviceToken = config.get<string>('SERVICE_AUTH_TOKEN', '');
    this.timeoutMs = config.get<number>('AUTH_API_TIMEOUT_MS', 30_000);
  }

  async run(): Promise<JobResult> {
    // Read at run time, not at boot. Both variables are optional in this
    // service's schema on purpose: `worker-service` holds no credential of its
    // own and must boot without one, so a missing seam fails *this job's run*
    // and leaves every other job running.
    if (!this.baseUrl) throw new Error('AUTH_API_BASE_URL is not set');
    if (!this.serviceToken) throw new Error('SERVICE_AUTH_TOKEN is not set');

    const destroyed = await this.destroyExpired();
    if (destroyed > 0) {
      this.logger.log(`destroyed ${destroyed} superseded credential version(s)`);
    }
    return {
      itemsProcessed: destroyed,
      errorsCount: 0,
      metrics: { destroyed },
    };
  }

  private async destroyExpired(): Promise<number> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${DESTROY_EXPIRED_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [RequestHeaders.serviceToken]: this.serviceToken,
        },
        body: '{}',
        signal: controller.signal,
      });

      if (!response.ok) {
        // 404 is the guard's answer to a caller it does not recognise, which
        // is the shape a rotated-away `SERVICE_AUTH_TOKEN` takes here. It is
        // indistinguishable from a route that does not exist — deliberately,
        // see `ServiceOnlyGuard` — so the message says what was asked, not why
        // it was refused.
        throw new Error(
          `auth-api answered ${response.status} to ${DESTROY_EXPIRED_PATH}`,
        );
      }

      const body: unknown = await response.json();
      const destroyed = (body as { destroyed?: unknown })?.destroyed;
      if (typeof destroyed !== 'number') {
        throw new Error(
          `auth-api answered ${DESTROY_EXPIRED_PATH} without a numeric 'destroyed'`,
        );
      }
      return destroyed;
    } finally {
      clearTimeout(timer);
    }
  }
}
