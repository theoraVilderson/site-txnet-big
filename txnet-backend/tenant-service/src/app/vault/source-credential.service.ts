import { Injectable, Logger } from '@nestjs/common';
import { MigrationRunKind, MigrationRunStatus, TenantCredentialKind } from '@prisma/client';
import {
  CredentialUnavailable,
  CredentialVaultService,
  openSourceLogin,
  ResellerAccess,
  ResellerAccessRefused,
  type ResellerAccessRejection,
  type ResellerActor,
  sealSourceLogin,
  SOURCE_CREDENTIAL_TTL_MS,
  sourceCredentialLabel,
  type SourcePanelLogin,
} from '@txnet-backend/shared-core';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';

export type SourceCredentialRejection = ResellerAccessRejection | 'run_not_found' | 'not_a_panel_run' | 'run_closed' | 'credential_unavailable';

/** How `network-service`'s source read is named in the vault's access log (F-201-b). */
export const SOURCE_READER_CALLER = 'network:SourceRead';

/**
 * The statuses in which a run still reads its source: until the commit starts.
 * From `committing` on the snapshot is all the run needs, and the login goes.
 */
const READS_ITS_SOURCE: readonly MigrationRunStatus[] = [MigrationRunStatus.draft, MigrationRunStatus.previewing, MigrationRunStatus.previewed];

/** What a reseller is answered: that it is stored, and until when. Never a value. */
export type SourceCredentialState = { configured: true; expiresAt: Date | null };

/** A refusal. Its message names the rule and the run, never a value. */
export class SourceCredentialRefused extends Error {
  constructor(readonly reason: SourceCredentialRejection, detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'SourceCredentialRefused';
  }
}

/**
 * An import's source login (F-201-d, D-63): the old panel's address and login,
 * in the reseller's own vault as `source_panel_credentials` under
 * `sourceCredentialLabel(runId)`, for that one run.
 *
 * The reseller stores it (`set`, behind `ResellerAccess` with
 * `migration.manage`) and is answered `{configured, expiresAt}` only;
 * `network-service` reads it (`use`) for a snapshot or a link batch; the
 * engine destroys it at commit or cancel (`destroy`). The run is read on the
 * cross-tenant pool by its id **and** the tenant the caller names, so a run id
 * never reaches another tenant's vault. A read restarts the 7 days; the sweep
 * destroys a login left past them (`DESTROYED_ON_EXPIRY`).
 */
@Injectable()
export class SourceCredentialService {
  private readonly logger = new Logger(SourceCredentialService.name);

  constructor(
    private readonly vault: CredentialVaultService,
    private readonly prisma: CrossTenantPrismaService,
    private readonly resellerAccess: ResellerAccess,
  ) {}

  async set(actor: ResellerActor, tenantId: string, runId: string, login: SourcePanelLogin, now = new Date()): Promise<SourceCredentialState> {
    await this.admit(actor, tenantId);
    const run = await this.run(tenantId, runId);
    if (!run) throw new SourceCredentialRefused('run_not_found', runId);
    if (run.kind !== MigrationRunKind.panel) throw new SourceCredentialRefused('not_a_panel_run', runId);
    if (!READS_ITS_SOURCE.includes(run.status)) throw new SourceCredentialRefused('run_closed', `${runId} is ${run.status}`);

    const stored = await this.vault.put(ref(tenantId, runId), sealSourceLogin(login), { createdBy: actor.userId, expiresAt: expiry(now) });
    this.logger.log(`source login for run ${runId} of tenant ${tenantId} stored`);
    return { configured: true, expiresAt: stored.expiresAt };
  }

  /** The reseller withdrawing it: a login typed wrong, or a run it will not finish. */
  async remove(actor: ResellerActor, tenantId: string, runId: string): Promise<void> {
    await this.admit(actor, tenantId);
    await this.destroy(tenantId, runId);
  }

  /**
   * The login, for `network-service`'s source read — the one place it leaves
   * the vault. A run that no longer reads its source has its login destroyed
   * here and is refused, so a commit or a cancel the engine failed to report
   * still ends it on the next read.
   */
  async use(tenantId: string, runId: string, now = new Date()): Promise<SourcePanelLogin> {
    const run = await this.run(tenantId, runId);
    if (!run || !READS_ITS_SOURCE.includes(run.status)) {
      await this.destroy(tenantId, runId);
      throw new SourceCredentialRefused('credential_unavailable', `${runId}: ${run ? `the run is ${run.status}` : 'no such run'}`);
    }
    let stored: string;
    try {
      stored = await this.vault.use(ref(tenantId, runId), { caller: SOURCE_READER_CALLER });
    } catch (e) {
      if (e instanceof CredentialUnavailable) throw new SourceCredentialRefused('credential_unavailable', `${runId}: ${e.reason}`);
      throw e;
    }
    const login = openSourceLogin(stored);
    if (!login) throw new SourceCredentialRefused('credential_unavailable', `${runId}: the stored value is not a source login`);
    // The same value again only moves the expiry (vault rule 3): 7 days from this read.
    await this.vault.put(ref(tenantId, runId), stored, { expiresAt: expiry(now) });
    return login;
  }

  /** Destroys every version of the run's login; answers how many rows went. Idempotent. */
  destroy(tenantId: string, runId: string): Promise<number> {
    return this.vault.destroy(ref(tenantId, runId));
  }

  private run(tenantId: string, runId: string) {
    return this.prisma.migrationRun.findFirst({ where: { id: runId, tenantId }, select: { kind: true, status: true } });
  }

  private async admit(actor: ResellerActor, tenantId: string): Promise<void> {
    try {
      await this.resellerAccess.for('migration.manage').admit(actor, tenantId, 'staffWrite');
    } catch (e) {
      if (e instanceof ResellerAccessRefused) throw new SourceCredentialRefused(e.reason, tenantId);
      throw e;
    }
  }
}

function ref(tenantId: string, runId: string) {
  return { tenantId, kind: TenantCredentialKind.source_panel_credentials, label: sourceCredentialLabel(runId) };
}

function expiry(now: Date): Date {
  return new Date(now.getTime() + SOURCE_CREDENTIAL_TTL_MS);
}
