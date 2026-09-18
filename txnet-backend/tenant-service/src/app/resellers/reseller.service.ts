import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, TenantType, UserStatus } from '@prisma/client';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { OwnerView, ResellerView, resellerHosts, slugInUse, writeReseller } from './reseller-rows';
import type { CreateResellerInput, ListResellersInput } from './reseller.schema';

/**
 * The platform owner creates, lists and reads resellers (F-018-c), moved out
 * of `auth-service` with F-018-y (ADR-0058).
 *
 * **A reseller names an existing user as its owner.** A person signs up on the
 * platform's own site and becomes a reseller; they stay the platform's customer
 * (ADR-0058 (4)). So `ownerUserId` must be a live, `active` user of the
 * platform owner's tenant, and this service never writes `identity.user` — it
 * would have to know how passwords are stored. The same path serves a
 * hand-made reseller and F-019-h's purchase.
 *
 * **Only the platform owner.** A reseller's rows are another tenant's, which
 * RLS refuses on the app pool, so the work runs on the cross-tenant pool and
 * {@link access} — on the app pool — refuses a non-owner before that pool is
 * touched (ADR-0053).
 *
 * **One transaction.** The `tenant` row, an empty `tenant_billing_wallet`, the
 * platform-issued `subdomain` `tenant_domain` and the audit row commit
 * together. The subdomain's `tenant:host:*` entry — which carries
 * `ownerUserId` since ADR-0059 — is deleted inside the transaction, so a Redis
 * that cannot be reached refuses the creation rather than leaving a cached
 * *no tenant* on the new host. Every write of `ownerUserId` goes through
 * `invalidateTenantOwner` (shared-core, F-061-k) the same way.
 */

export type ResellerActor = { adminId: string; tenantId: string; ip: string };

export type { ResellerView } from './reseller-rows';

export type ResellerRejection = 'not_platform_owner' | 'slug_taken' | 'reseller_not_found' | 'owner_not_found' | 'owner_inactive';

export class ResellerRefused extends Error {
  constructor(
    readonly reason: ResellerRejection,
    detail = '',
  ) {
    super(`reseller refused: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'ResellerRefused';
  }
}

const OWNER_SELECT = { id: true, fullName: true, username: true, phoneNumber: true } satisfies Prisma.UserSelect;

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
export class ResellerService {
  private readonly logger = new Logger(ResellerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly all: CrossTenantPrismaService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  async create(actor: ResellerActor, input: CreateResellerInput): Promise<ResellerView> {
    await this.access(actor);

    const slug = input.slug;
    const hosts = resellerHosts(slug, this.config.get<string>('DOMAIN_NAME') as string);
    const [taken, person] = await Promise.all([
      slugInUse(this.all, slug, hosts[0]),
      // The platform owner's tenant is the caller's: `access` just proved it.
      this.all.user.findFirst({
        where: { id: input.ownerUserId, tenantId: actor.tenantId, deletedAt: null },
        select: { ...OWNER_SELECT, status: true },
      }),
    ]);
    if (taken) throw new ResellerRefused('slug_taken', slug);
    if (!person) throw new ResellerRefused('owner_not_found', input.ownerUserId);
    if (person.status !== UserStatus.active) throw new ResellerRefused('owner_inactive', input.ownerUserId);
    const owner: OwnerView = { id: person.id, fullName: person.fullName, username: person.username, phoneNumber: person.phoneNumber };

    try {
      const view = await this.all.$transaction((tx) =>
        writeReseller(tx, this.redis, { slug, hosts, billingModel: input.billingModel, owner, actorId: actor.adminId, ip: actor.ip }),
      );
      this.logger.log(`reseller ${view.id} (${slug}) created by ${actor.adminId}, owned by ${owner.id}`);
      return view;
    } catch (e) {
      // Lost a race on `tenant.slug` or `tenant_domain.domainValue`.
      if ((e as { code?: string })?.code === 'P2002') throw new ResellerRefused('slug_taken', slug);
      throw e;
    }
  }

  async list(actor: ResellerActor, page: ListResellersInput): Promise<ResellerView[]> {
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

  async read(actor: ResellerActor, id: string): Promise<ResellerView> {
    await this.access(actor);
    const row = await this.all.tenant.findFirst({
      where: { id, tenantType: TenantType.reseller, deletedAt: null },
      select: RESELLER_SELECT,
    });
    if (!row) throw new ResellerRefused('reseller_not_found', id);
    const [view] = await this.withOwners([row]);
    return view;
  }

  /** The one owner check; a non-owner is refused before the cross-tenant pool is touched (ADR-0053). */
  private async access(actor: ResellerActor): Promise<void> {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: actor.tenantId }, select: { tenantType: true } });
    if (tenant?.tenantType !== TenantType.platform_owner) {
      throw new ResellerRefused('not_platform_owner', 'reseller administration');
    }
  }

  private async withOwners(rows: ResellerRow[]): Promise<ResellerView[]> {
    const owners = await this.all.user.findMany({
      where: { id: { in: rows.map((r) => r.ownerUserId) } },
      select: OWNER_SELECT,
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
