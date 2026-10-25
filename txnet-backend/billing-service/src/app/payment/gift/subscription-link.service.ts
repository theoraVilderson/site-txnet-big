import { ConflictException, HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DomainVerificationStatus, Prisma, TenantDomainPurpose, TenantDomainType } from '@prisma/client';
import { BackendI18nKeys, bestHostOf, TenantContext, tenantTransaction } from '@txnet-backend/shared-core';

import type { EnvConfig } from '../../config/env.validation';
import { EntitlementRefused, GrantService } from '../../entitlement/grant';
import { assertOwnerResetRoom, LinkResetLimited } from '../../entitlement/link-reset';
import { PrismaService } from '../../prisma/prisma.service';

const E = BackendI18nKeys.errors.billing.grant;

/**
 * A Grant's subscription link for its own user (F-114-e-b, D-43, ADR-0085):
 * `https://<tenant subscription domain>/sub/<token>`, as often as asked, and
 * "reset link" — a new token for a link that leaked, answered as its URL.
 *
 * Two refusals are named, both **409**: the tenant has no subscription domain
 * (`no_subscription_domain`), and the Grant keeps no sealed token
 * (`link_not_kept` — issued before F-114-e-a or with no KEK; a reset keeps one).
 * Another user's Grant is the same **404** as a missing one, and is decided
 * before a domain is read, so no other refusal says an id exists.
 */
/** Runs around a reset's rotation, in its transaction: an admin's is audited there (F-311-r). */
export type AroundRotate = (tx: Prisma.TransactionClient, rotate: () => Promise<string>) => Promise<string>;

@Injectable()
export class SubscriptionLinkService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly grants: GrantService,
    private readonly config: ConfigService<EnvConfig, true>,
  ) {}

  linkFor(grantId: string, userId: string): Promise<string> {
    return this.refusing(() =>
      tenantTransaction(this.prisma, async (tx) => {
        const token = await this.grants.subscriptionTokenFor(tx, grantId, userId);
        const host = await this.host(tx);
        if (!token) throw new ConflictException({ i18nKey: E.linkNotKept, reason: 'link_not_kept', message: `Grant ${grantId} keeps no subscription token.` });
        return `https://${host}/sub/${token}`;
      }),
    );
  }

  /**
   * The host is found **before** the rotation: a reset that rotated and then
   * found no host would destroy the working link and answer nothing. Both are
   * one transaction, so the old link stops exactly when the new one exists.
   */
  reset(grantId: string, userId: string, around: AroundRotate = (_tx, rotate) => rotate()): Promise<string> {
    return this.refusing(() =>
      tenantTransaction(this.prisma, async (tx) => {
        const host = await this.host(tx);
        return around(tx, async () => `https://${host}/sub/${await this.grants.rotateToken(tx, grantId, userId)}`);
      }),
    );
  }

  /**
   * The owner's own reset (F-114-e-d): at most 3 per Grant in 24 hours, counted
   * under the Grant's lock and recorded in the rotation's transaction. Staff
   * and a reseller's admin call `reset` and are not bounded by it.
   */
  resetOwn(grantId: string, userId: string): Promise<string> {
    return this.reset(grantId, userId, async (tx, rotate) => {
      const tenantId = await assertOwnerResetRoom(tx, grantId, userId);
      const url = await rotate();
      await tx.grantLinkReset.create({ data: { tenantId, grantId } });
      return url;
    });
  }

  private async host(tx: Prisma.TransactionClient): Promise<string> {
    const rows = await tx.tenantDomain.findMany({
      where: {
        tenantId: TenantContext.current('a subscription link').id,
        purpose: TenantDomainPurpose.subscription,
        OR: [{ domainType: TenantDomainType.subdomain }, { verificationStatus: DomainVerificationStatus.verified }],
      },
      select: { domainValue: true, domainType: true },
    });
    // The routable rows are `sub-service`'s own rule (`servesSubscriptions`);
    // a reseller's platform subdomain is an answer here, unlike a panel's
    // (ADR-0063 is the panel's rule). The platform's domestic door comes first
    // (NIN-1-d3): a link the user keeps must outlive a cut.
    const host = bestHostOf(rows, this.config.get('DOMESTIC_DOMAIN_NAME', { infer: true }));
    if (!host) {
      throw new ConflictException({
        i18nKey: E.noSubscriptionDomain,
        reason: 'no_subscription_domain',
        message: 'The tenant has no routable subscription domain.',
      });
    }
    return host;
  }

  private async refusing<R>(fn: () => Promise<R>): Promise<R> {
    try {
      return await fn();
    } catch (e) {
      // The owner's fourth reset in a day: the old link keeps working, and the
      // refusal says when the next is allowed, as epoch ms (`facts` carries no text).
      if (e instanceof LinkResetLimited) {
        throw new HttpException(
          {
            i18nKey: E.linkResetLimited,
            reason: e.reason,
            message: `${e.name}: ${e.message}`,
            facts: { limit: e.limit, nextAtMs: e.nextAt.getTime() },
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      if (e instanceof EntitlementRefused && e.reason === 'grant_not_found') {
        throw new NotFoundException({ i18nKey: E.notFound, reason: e.reason, message: `${e.name}: ${e.message}` });
      }
      throw e;
    }
  }
}
