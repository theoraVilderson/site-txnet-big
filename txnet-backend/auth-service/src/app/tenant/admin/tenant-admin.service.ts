import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AdminAction,
  AuditTargetType,
  Prisma,
  TenantDomainPurpose,
  TenantDomainType,
  TenantStatus,
  TenantType,
} from '@prisma/client';
import * as argon2 from 'argon2';
import { assertPasswordNotContainingProfile } from '../../common/validation/strong-password.schema';
import { CrossTenantPrismaService } from '../../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TenantCacheService } from '../tenant-cache.service';
import type { CreateResellerInput, ListResellersInput } from './tenant-admin.schema';

/**
 * The platform owner creates, lists and reads resellers (F-018-c).
 *
 * **Only the platform owner.** A reseller's rows are another tenant's, which
 * RLS refuses on the app pool, so the work runs on the cross-tenant pool and
 * {@link access} — on the app pool — refuses a non-owner before that pool is
 * touched (ADR-0053, the same order as `TenantBillingAdminService`).
 *
 * **One transaction.** The `tenant` row, its owner `user` (system role
 * `Admin` until tenant-scoped roles, F-018-n), an empty
 * `tenant_billing_wallet`, the platform-issued `subdomain` `tenant_domain`
 * and the audit row commit together. The subdomain's cached resolution is
 * retracted inside the transaction, so a Redis that cannot be reached refuses
 * the creation rather than leaving a cached *no tenant* on the new host
 * (tenant contract, ADR-0025 decision 4).
 *
 * The owner's phone is not marked verified: the platform owner types it, the
 * reseller's owner proves it on first sign-in (identity invariant 6). The
 * password is chosen by the platform owner and never echoed back.
 */

export type TenantAdminActor = { adminId: string; tenantId: string; ip: string };

export type ResellerView = {
  id: string;
  slug: string;
  status: TenantStatus;
  billingModel: string;
  createdAt: Date;
  owner: { id: string; fullName: string; username: string | null; phoneNumber: string | null } | null;
  domains: { domainValue: string; domainType: TenantDomainType; purpose: TenantDomainPurpose; verificationStatus: string }[];
  billingBalance: string;
};

export type TenantAdminRejection = 'not_platform_owner' | 'slug_taken' | 'reseller_not_found';

export class TenantAdminRefused extends Error {
  constructor(
    readonly reason: TenantAdminRejection,
    detail = '',
  ) {
    super(`tenant admin refused: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'TenantAdminRefused';
  }
}

/** The system role a reseller's owner holds until roles are per tenant (F-018-n). */
const OWNER_ROLE = 'Admin';

const RESELLER_SELECT = {
  id: true,
  slug: true,
  status: true,
  billingModel: true,
  createdAt: true,
  ownerUserId: true,
  domains: { select: { domainValue: true, domainType: true, purpose: true, verificationStatus: true } },
  billingWallet: { select: { cachedBalance: true } },
} satisfies Prisma.TenantSelect;

type ResellerRow = Prisma.TenantGetPayload<{ select: typeof RESELLER_SELECT }>;

@Injectable()
export class TenantAdminService {
  private readonly logger = new Logger(TenantAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly all: CrossTenantPrismaService,
    private readonly cache: TenantCacheService,
    private readonly config: ConfigService,
  ) {}

  async create(actor: TenantAdminActor, input: CreateResellerInput): Promise<ResellerView> {
    await this.access(actor);

    const slug = input.slug;
    const domainValue = `${slug}.${this.config.get<string>('DOMAIN_NAME')}`.toLowerCase();
    const [bySlug, byHost] = await Promise.all([
      this.all.tenant.findUnique({ where: { slug }, select: { id: true } }),
      this.all.tenantDomain.findUnique({ where: { domainValue }, select: { id: true } }),
    ]);
    if (bySlug || byHost) throw new TenantAdminRefused('slug_taken', slug);

    const { owner } = input;
    assertPasswordNotContainingProfile(owner.password, owner);
    const role = await this.all.role.findUnique({ where: { name: OWNER_ROLE }, select: { id: true } });
    if (!role) throw new Error(`system role ${OWNER_ROLE} is missing — run the seed`);
    const passwordHash = await argon2.hash(owner.password, { type: argon2.argon2id });

    try {
      const view = await this.all.$transaction(async (tx) => {
        const ownerId = randomUUID();
        const tenant = await tx.tenant.create({
          data: {
            tenantType: TenantType.reseller,
            ownerUserId: ownerId,
            slug,
            status: TenantStatus.trial,
            billingModel: input.billingModel,
          },
        });
        await tx.user.create({
          data: {
            id: ownerId,
            tenantId: tenant.id,
            fullName: owner.fullName,
            username: owner.username,
            phoneNumber: owner.phoneNumber,
            passwordHash,
            roleId: role.id,
          },
        });
        // Empty: no balance is written here (tenant invariant 3).
        await tx.tenantBillingWallet.create({ data: { tenantId: tenant.id } });
        // A subdomain routes as it stands — the platform issued it (tenant invariant 5 is for custom domains).
        const domain = await tx.tenantDomain.create({
          data: {
            tenantId: tenant.id,
            domainType: TenantDomainType.subdomain,
            domainValue,
            purpose: TenantDomainPurpose.panel,
          },
        });
        const result: ResellerView = {
          id: tenant.id,
          slug: tenant.slug,
          status: tenant.status,
          billingModel: tenant.billingModel,
          createdAt: tenant.createdAt,
          owner: { id: ownerId, fullName: owner.fullName, username: owner.username, phoneNumber: owner.phoneNumber },
          domains: [
            {
              domainValue: domain.domainValue,
              domainType: domain.domainType,
              purpose: domain.purpose,
              verificationStatus: domain.verificationStatus,
            },
          ],
          billingBalance: '0',
        };
        await tx.adminAuditLog.create({
          data: {
            tenantId: tenant.id,
            adminId: actor.adminId,
            action: AdminAction.tenant_create,
            targetEntityType: AuditTargetType.tenant,
            targetEntityId: tenant.id,
            newValue: JSON.parse(JSON.stringify(result)) as Prisma.InputJsonValue,
            adminIpAddress: actor.ip,
          },
        });
        await this.cache.invalidateDomain(domainValue);
        return result;
      });
      this.logger.log(`reseller ${view.id} (${slug}) created by ${actor.adminId}`);
      return view;
    } catch (e) {
      // Lost a race on `tenant.slug` or `tenant_domain.domainValue` (the owner's username is unique per tenant, and this tenant is new).
      if ((e as { code?: string })?.code === 'P2002') throw new TenantAdminRefused('slug_taken', slug);
      throw e;
    }
  }

  async list(actor: TenantAdminActor, page: ListResellersInput): Promise<ResellerView[]> {
    await this.access(actor);
    const rows = await this.all.tenant.findMany({
      where: { tenantType: TenantType.reseller, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: page.limit,
      skip: page.offset,
      select: RESELLER_SELECT,
    });
    return this.withOwners(rows);
  }

  async read(actor: TenantAdminActor, id: string): Promise<ResellerView> {
    await this.access(actor);
    const row = await this.all.tenant.findFirst({
      where: { id, tenantType: TenantType.reseller, deletedAt: null },
      select: RESELLER_SELECT,
    });
    if (!row) throw new TenantAdminRefused('reseller_not_found', id);
    const [view] = await this.withOwners([row]);
    return view;
  }

  /** The one owner check; a non-owner is refused before the cross-tenant pool is touched (ADR-0053). */
  private async access(actor: TenantAdminActor): Promise<void> {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: actor.tenantId }, select: { tenantType: true } });
    if (tenant?.tenantType !== TenantType.platform_owner) {
      throw new TenantAdminRefused('not_platform_owner', 'reseller administration');
    }
  }

  private async withOwners(rows: ResellerRow[]): Promise<ResellerView[]> {
    const owners = await this.all.user.findMany({
      where: { id: { in: rows.map((r) => r.ownerUserId) } },
      select: { id: true, fullName: true, username: true, phoneNumber: true },
    });
    const byId = new Map(owners.map((o) => [o.id, o]));
    return rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      status: r.status,
      billingModel: r.billingModel,
      createdAt: r.createdAt,
      owner: byId.get(r.ownerUserId) ?? null,
      domains: r.domains,
      billingBalance: r.billingWallet?.cachedBalance.toString() ?? '0',
    }));
  }
}
