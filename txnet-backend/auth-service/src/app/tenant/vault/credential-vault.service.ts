import { Injectable, Logger } from '@nestjs/common';
import { TenantCredentialKind, TenantCredentialStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { KekService } from './kek.service';
import {
  fingerprint,
  fingerprintsMatch,
  generateKey,
  open,
  seal,
} from './vault.crypto';

/**
 * The Credential Vault (ADR-0026, catalog 20.4 — F-1213, F-1214, F-1215,
 * F-1217, and catalog 20.2's layer 5, F-1207).
 *
 * Every third-party secret a tenant owns — a bot token, a gateway key, a panel
 * login — is stored here and nowhere else, encrypted under **that tenant's own
 * DEK**, which is itself wrapped by a KEK held outside the database. The
 * per-tenant key is the whole point: with one platform key, a leaked ciphertext
 * plus the key is a takeover of every reseller's payment account at once, and
 * catalog 20.2 layer 5 asks for the opposite — a failure confined to one
 * tenant.
 *
 * **What this service will not do.** It has no operation that returns a
 * plaintext to a caller that did not name the exact credential it needs to
 * use, and it has no operation that lists plaintexts at all. An admin surface
 * gets {@link CredentialSummary} — `{configured, fingerprint, status,
 * lastUsedAt}` — at *every* role, including the highest (ADR-0026 guarantee 1).
 * That is a rule about the shape of this class, not about its callers, which is
 * why there is no `select` for anyone to get wrong.
 *
 * **Why these two tables are not in `TENANT_SCOPED_MODELS`.** The ambient scope
 * (ADR-0024) is opened from a resolved request, and the first real reader of
 * this vault is F-066-i, which looks a bot integration up *by its webhook path
 * in order to discover which tenant the request belongs to* — before any tenant
 * is resolved. Registering these models would make that lookup throw. The
 * confinement here is the DEK and the mandatory `tenantId` argument on every
 * method below, not the extension; see `contract.vault.md`.
 */

/** What an admin surface may see about a credential. Never the value. */
export interface CredentialSummary {
  kind: TenantCredentialKind;
  label: string;
  configured: boolean;
  fingerprint: string;
  status: TenantCredentialStatus;
  version: number;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  rotatedAt: Date | null;
}

/**
 * Who is decrypting a credential, and on whose behalf (ADR-0026 decision 5).
 *
 * Both halves are the audit row's reason for existing, which is why they are
 * one required argument rather than an optional trailing string: a decryption
 * whose caller nobody named is exactly the one an operator will need to
 * explain later.
 */
export interface CredentialAccess {
  /**
   * The code path about to use the value — `'messenger:BotClientRegistry'`,
   * `'billing:ZarinpalGateway'`. Free text on purpose: the set of callers
   * grows with every integration, and an enum would put a migration in front
   * of each one.
   */
  caller: string;
  /**
   * The person this is happening for, when there is one. A webhook or a
   * scheduled worker has none, and `null` says that rather than naming a
   * stand-in that an audit reader would take for a human.
   */
  actorId?: string | null;
}

/** Where a credential is asked for, when it is asked for. */
export interface CredentialRef {
  tenantId: string;
  kind: TenantCredentialKind;
  /** Which one, when a tenant holds several of a kind. Defaults to the singular. */
  label?: string;
}

/** Raised when a credential is asked for and there is no usable version. */
export class CredentialUnavailable extends Error {
  constructor(
    readonly ref: CredentialRef,
    readonly reason: 'missing' | 'expired' | 'revoked',
  ) {
    super(
      `No usable ${ref.kind} credential for tenant ${ref.tenantId}` +
        `${ref.label ? ` (${ref.label})` : ''}: ${reason}.`,
    );
    this.name = 'CredentialUnavailable';
  }
}

/**
 * How long a superseded version stays readable after a rotation (ADR-0026
 * decision 4).
 *
 * An in-flight webhook was signed against the previous secret and arrives
 * seconds to minutes after the rotation; a window measured in hours costs
 * nothing and covers a retry. It is not configuration: shortening it below the
 * time a platform takes to redeliver is what the window exists to prevent, and
 * lengthening it keeps a rotated-away secret alive, which is what a rotation
 * was for.
 */
export const ROTATION_GRACE_SEC = 6 * 60 * 60;

@Injectable()
export class CredentialVaultService {
  private readonly logger = new Logger(CredentialVaultService.name);

  /**
   * Unwrapped DEKs, by `TenantDek.id`.
   *
   * Safe as an in-process `Map` in a way the host cache (`TenantCacheService`)
   * was not, and for a reason worth stating: a DEK row is immutable once
   * written — a rotation writes a *new* row with a new id and retires the old
   * one. So this cache is keyed by something that can never mean a different
   * value later, and there is nothing to invalidate. What it holds is key
   * material, so it stays in memory and never reaches Redis.
   */
  private readonly dekCache = new Map<string, Buffer>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly kek: KekService,
  ) {}

  /** Whether this deployment can store credentials at all — see {@link KekService}. */
  get available(): boolean {
    return this.kek.available;
  }

  /**
   * Store a credential, or rotate it if one is already there.
   *
   * Rotation is the same call deliberately: a caller that had to ask "is there
   * one already?" first would race with itself and would sometimes take the
   * create path over a live secret. Writing the same value again is a no-op
   * rather than a version bump — that is what the fingerprint is for, and it
   * keeps a provisioning job that re-applies its configuration from burning a
   * version and a grace window every run.
   */
  async put(
    ref: CredentialRef,
    plaintext: string,
    options: { createdBy?: string; expiresAt?: Date | null } = {},
  ): Promise<CredentialSummary> {
    const label = ref.label ?? '';
    const fp = fingerprint(plaintext);
    const current = await this.activeRow({ ...ref, label });

    if (current && fingerprintsMatch(current.fingerprint, fp)) {
      // Same value. Honour an expiry change, which is a real edit, and leave
      // the version, the ciphertext and the grace window alone.
      const expiresAt =
        options.expiresAt === undefined ? current.expiresAt : options.expiresAt;
      if (expiresAt?.getTime() !== current.expiresAt?.getTime()) {
        const updated = await this.prisma.tenantCredential.update({
          where: { id: current.id },
          data: { expiresAt },
        });
        return this.summarize(updated);
      }
      return this.summarize(current);
    }

    const dek = await this.activeDek(ref.tenantId);
    const sealed = seal(plaintext, dek.key);
    const version = current ? current.version + 1 : 1;
    const now = new Date();

    // One transaction, and the order inside it is forced: the partial unique
    // index allows only one `active` row per (tenant, kind, label), so the old
    // version must be superseded before the new one is written. Doing it in
    // two calls would leave a window where a rotation that half-failed left
    // the tenant with no active credential at all.
    const created = await this.prisma.$transaction(async (tx) => {
      if (current) {
        await tx.tenantCredential.update({
          where: { id: current.id },
          data: { status: TenantCredentialStatus.superseded, rotatedAt: now },
        });
      }
      return tx.tenantCredential.create({
        data: {
          tenantId: ref.tenantId,
          kind: ref.kind,
          label,
          ciphertext: sealed.ciphertext,
          iv: sealed.iv,
          authTag: sealed.authTag,
          dekId: dek.id,
          fingerprint: fp,
          status: TenantCredentialStatus.active,
          version,
          createdBy: options.createdBy ?? null,
          expiresAt: options.expiresAt ?? null,
        },
      });
    });

    this.logger.log(
      // The kind, the tenant and the version — never the value, and never the
      // fingerprint either, since a log is the one place both a short secret
      // and unlimited guesses are available at once (ADR-0026 guarantee 1).
      `${current ? 'Rotated' : 'Stored'} ${ref.kind} for tenant ` +
        `${ref.tenantId} (version ${version}).`,
    );
    return this.summarize(created);
  }

  /**
   * The plaintext of a credential, for the code that is about to use it.
   *
   * This is the only method that returns one, and **every call writes an
   * audit row** (ADR-0026 decision 5, F-1215): who, which tenant, which kind,
   * which caller — never the value and never the fingerprint.
   *
   * The row is written *before* the plaintext is returned, and a failure to
   * write it fails the call. That is the opposite of what `lastUsedAt` does
   * ten lines below, and the difference is deliberate: `lastUsedAt` is an
   * operator convenience, so losing one must not take a bot down with it,
   * whereas the audit row is the guarantee itself. An unaudited decryption is
   * not a decryption this service is willing to have performed, so it is not
   * one it will hand a value back for.
   *
   * `verify` and `matches` write nothing. They compare fingerprints and
   * decrypt nothing, so there is no decryption to audit — recording them here
   * would make the trail's meaning "someone asked" rather than "someone held
   * the value", which is the question it exists to answer.
   */
  async use(ref: CredentialRef, access: CredentialAccess): Promise<string> {
    const row = await this.activeRow({ ...ref, label: ref.label ?? '' });
    if (!row) throw new CredentialUnavailable(ref, 'missing');
    if (row.status === TenantCredentialStatus.revoked) {
      throw new CredentialUnavailable(ref, 'revoked');
    }
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
      // Expiry is checked on read, not by a sweeper: a credential that expired
      // one second ago must stop working now, and a worker that runs every
      // five minutes would keep it alive for five (F-1217).
      throw new CredentialUnavailable(ref, 'expired');
    }

    const key = await this.dekKey(row.dekId);
    const plaintext = open(row, key, `${ref.kind} for tenant ${ref.tenantId}`);

    // Awaited, and not wrapped in a catch — see the note on this method. The
    // row names the version, so a rotation is legible in the trail rather
    // than being a run of identical lines.
    await this.prisma.tenantCredentialAccess.create({
      data: {
        tenantId: row.tenantId,
        credentialId: row.id,
        kind: row.kind,
        label: row.label,
        version: row.version,
        caller: access.caller,
        actorId: access.actorId ?? null,
      },
    });

    // `lastUsedAt` is what tells an operator a credential is still in the path
    // before they revoke it. Not awaited into the caller's latency, and a
    // failure to record it must not fail the operation that needed the value.
    this.prisma.tenantCredential
      .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
      .catch((err: unknown) =>
        this.logger.warn(
          `Could not record lastUsedAt for ${ref.kind} on tenant ` +
            `${ref.tenantId}: ${(err as Error).message}`,
        ),
      );

    this.logger.debug(
      `${access.caller} used ${ref.kind} for tenant ${ref.tenantId}.`,
    );
    return plaintext;
  }

  /**
   * Verify a value against a stored credential without decrypting it.
   *
   * The path a webhook's secret token takes: compare fingerprints, and accept
   * a `superseded` version that is still inside its grace window, so an update
   * signed just before a rotation still verifies (ADR-0026 decision 4).
   */
  async verify(ref: CredentialRef, candidate: string): Promise<boolean> {
    const fp = fingerprint(candidate);
    const rows = await this.prisma.tenantCredential.findMany({
      where: {
        tenantId: ref.tenantId,
        kind: ref.kind,
        label: ref.label ?? '',
        status: {
          in: [
            TenantCredentialStatus.active,
            TenantCredentialStatus.superseded,
          ],
        },
      },
    });

    const graceFloor = Date.now() - ROTATION_GRACE_SEC * 1000;
    return rows.some((row) => {
      if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return false;
      if (
        row.status === TenantCredentialStatus.superseded &&
        (row.rotatedAt?.getTime() ?? 0) <= graceFloor
      ) {
        return false;
      }
      return fingerprintsMatch(row.fingerprint, fp);
    });
  }

  /**
   * Is this the value you already have? (F-1214.)
   *
   * The question an admin UI asks when someone pastes a token in, so it can
   * say "unchanged" instead of rotating a live bot for nothing.
   */
  async matches(ref: CredentialRef, candidate: string): Promise<boolean> {
    const row = await this.activeRow({ ...ref, label: ref.label ?? '' });
    return row ? fingerprintsMatch(row.fingerprint, fingerprint(candidate)) : false;
  }

  /** What an admin surface sees. Every role, including the highest. */
  async summary(ref: CredentialRef): Promise<CredentialSummary | null> {
    const row = await this.activeRow({ ...ref, label: ref.label ?? '' });
    return row ? this.summarize(row) : null;
  }

  /** Every credential a tenant holds, as summaries. Still never a value. */
  async list(tenantId: string): Promise<CredentialSummary[]> {
    const rows = await this.prisma.tenantCredential.findMany({
      where: { tenantId, status: TenantCredentialStatus.active },
      orderBy: [{ kind: 'asc' }, { label: 'asc' }],
    });
    return rows.map((row) => this.summarize(row));
  }

  /**
   * Stop a credential working now, keeping the row.
   *
   * Revocation is not deletion: the row is what an audit trail points at, and
   * what tells the next operator that this tenant *had* a gateway key and it
   * was withdrawn, rather than that one was never configured.
   */
  async revoke(ref: CredentialRef): Promise<void> {
    const row = await this.activeRow({ ...ref, label: ref.label ?? '' });
    if (!row) return;
    await this.prisma.tenantCredential.update({
      where: { id: row.id },
      data: { status: TenantCredentialStatus.revoked, rotatedAt: new Date() },
    });
  }

  /**
   * Destroy superseded versions whose grace window has passed (ADR-0026
   * decision 4: *"kept for a grace window … then destroyed"*).
   *
   * Called by whatever schedules it — `automation` owns workers (F-031) and
   * this deliberately does not schedule itself. Until something calls it a
   * rotated secret stays in the database past its window, which is why the
   * obligation is written into `contract.vault.md` rather than left here.
   */
  async destroyExpiredVersions(now = new Date()): Promise<number> {
    const floor = new Date(now.getTime() - ROTATION_GRACE_SEC * 1000);
    const { count } = await this.prisma.tenantCredential.deleteMany({
      where: {
        status: TenantCredentialStatus.superseded,
        rotatedAt: { lte: floor },
      },
    });
    if (count > 0) {
      this.logger.log(`Destroyed ${count} superseded credential version(s).`);
    }
    return count;
  }

  /** The active version, or `null`. Always filtered by tenant — see the class note. */
  private activeRow(ref: Required<CredentialRef>) {
    return this.prisma.tenantCredential.findFirst({
      where: {
        tenantId: ref.tenantId,
        kind: ref.kind,
        label: ref.label,
        status: {
          in: [TenantCredentialStatus.active, TenantCredentialStatus.revoked],
        },
      },
      orderBy: { version: 'desc' },
    });
  }

  /**
   * This tenant's live DEK, creating one the first time it stores anything.
   *
   * The unique constraint that would make this race-proof is not expressible
   * (`retiredAt IS NULL` per tenant is another partial index), so a concurrent
   * first write could create two DEKs for one tenant. That is not a
   * correctness problem here and is worth saying why: each credential records
   * the `dekId` it was sealed under, so both keys stay readable and neither
   * orphans a row. The loser is a spare key nobody uses.
   */
  private async activeDek(
    tenantId: string,
  ): Promise<{ id: string; key: Buffer }> {
    const existing = await this.prisma.tenantDek.findFirst({
      where: { tenantId, retiredAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) {
      return { id: existing.id, key: await this.dekKey(existing.id) };
    }

    const dek = generateKey();
    const wrapped = seal(dek.toString('base64'), this.kek.activeKey());
    const row = await this.prisma.tenantDek.create({
      data: {
        tenantId,
        // The wrapped key is one column, so the IV and tag travel with it.
        wrappedKey: `${wrapped.iv}.${wrapped.authTag}.${wrapped.ciphertext}`,
        kekId: this.kek.activeKekId,
      },
    });
    this.dekCache.set(row.id, dek);
    this.logger.log(`Created a data key for tenant ${tenantId}.`);
    return { id: row.id, key: dek };
  }

  /** Unwrap a DEK, once per process — see {@link dekCache}. */
  private async dekKey(dekId: string): Promise<Buffer> {
    const cached = this.dekCache.get(dekId);
    if (cached) return cached;

    const row = await this.prisma.tenantDek.findUnique({ where: { id: dekId } });
    if (!row) {
      throw new Error(
        `tenant_dek ${dekId} is missing, so every credential sealed under it ` +
          `is unreadable. Restore it from a backup — this is the per-tenant ` +
          `loss ADR-0026 accepted.`,
      );
    }

    const [iv, authTag, ciphertext] = row.wrappedKey.split('.');
    const key = Buffer.from(
      open(
        { iv, authTag, ciphertext },
        this.kek.keyFor(row.kekId),
        `the data key for tenant ${row.tenantId}`,
      ),
      'base64',
    );
    this.dekCache.set(dekId, key);
    return key;
  }

  /** The only shape that leaves this service, other than a used plaintext. */
  private summarize(row: {
    kind: TenantCredentialKind;
    label: string;
    fingerprint: string;
    status: TenantCredentialStatus;
    version: number;
    lastUsedAt: Date | null;
    expiresAt: Date | null;
    rotatedAt: Date | null;
  }): CredentialSummary {
    return {
      kind: row.kind,
      label: row.label,
      configured: row.status === TenantCredentialStatus.active,
      fingerprint: row.fingerprint,
      status: row.status,
      version: row.version,
      lastUsedAt: row.lastUsedAt,
      expiresAt: row.expiresAt,
      rotatedAt: row.rotatedAt,
    };
  }
}

/** Re-exported so a caller names a kind without importing from `@prisma/client`. */
export { TenantCredentialKind, TenantCredentialStatus };
