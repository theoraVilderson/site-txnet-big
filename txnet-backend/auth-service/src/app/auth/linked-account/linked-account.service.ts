import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CrossTenantPrismaService } from '../../prisma/cross-tenant-prisma.service';
import { TenantContext } from '../../tenant-context/tenant-context';
import { err, ok, safeExecute } from '../../common/response/response.util';

/** The system role a reseller's owner holds until roles are per tenant (F-018-n). */
export const RESELLER_OWNER_ROLE = 'Admin';

/** The columns of an account that decide which credential it answers with. */
export type CredentialFields = {
  credentialUserId: string | null;
  passwordHash: string | null;
  twoFactorEnabled: boolean;
};

/** The password and 2FA setting a sign-in is checked against. */
export type Credentials = { passwordHash: string; twoFactorEnabled: boolean };

/**
 * A reseller's owner is an account in the reseller's tenant that signs in with
 * the credentials of their platform account (ADR-0059).
 *
 * **Why this reads across tenants.** The account the link names lives in
 * another tenant by construction — the platform's — so the ambient scope of a
 * sign-in on the reseller's host can never see it. It reads that one row by id
 * and only the columns a sign-in needs; everything else about the session stays
 * the linked account's own, in its own tenant.
 */
@Injectable()
export class LinkedAccountService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly all: CrossTenantPrismaService,
  ) {}

  /**
   * Which password and 2FA setting this account signs in with, or `null` when
   * it cannot sign in by password at all. Every failure is the same `null`, so
   * a caller answering "invalid credentials" reveals nothing about the link.
   */
  async credentialsOf(user: CredentialFields): Promise<Credentials | null> {
    if (!user.credentialUserId) {
      return user.passwordHash
        ? { passwordHash: user.passwordHash, twoFactorEnabled: user.twoFactorEnabled }
        : null;
    }
    const holder = await this.all.user.findUnique({
      where: { id: user.credentialUserId },
      select: {
        passwordHash: true,
        twoFactorEnabled: true,
        status: true,
        deletedAt: true,
        credentialUserId: true,
      },
    });
    if (
      !holder ||
      holder.deletedAt ||
      holder.status !== 'active' ||
      holder.credentialUserId ||
      !holder.passwordHash
    ) {
      return null;
    }
    return { passwordHash: holder.passwordHash, twoFactorEnabled: holder.twoFactorEnabled };
  }

  /**
   * The owner's account in the ambient tenant, linked to `credentialUserId`
   * (ADR-0059 (6)). Idempotent: a second call, or a concurrent one that lost the
   * race to the unique index, answers with the account already there.
   */
  async createOwnerAccount(credentialUserId: string) {
    return safeExecute(async () => {
      const tenant = TenantContext.current('owner account');
      const holder = await this.all.user.findUnique({
        where: { id: credentialUserId },
        select: {
          tenantId: true,
          fullName: true,
          phoneNumber: true,
          phoneVerifiedAt: true,
          status: true,
          deletedAt: true,
          credentialUserId: true,
        },
      });
      if (
        !holder ||
        holder.deletedAt ||
        holder.status !== 'active' ||
        holder.credentialUserId ||
        holder.tenantId === tenant.id ||
        !holder.phoneVerifiedAt
      ) {
        return err('tenant.ownerAccountInvalid');
      }

      const existing = await this.linkedTo(credentialUserId);
      if (existing) return ok({ userId: existing.id }, 'tenant.ownerAccountReady');

      const role = await this.prisma.role.findUnique({
        where: { name: RESELLER_OWNER_ROLE },
        select: { id: true },
      });
      if (!role) throw new Error(`system role ${RESELLER_OWNER_ROLE} is missing — run the seed`);

      try {
        const user = await this.prisma.user.create({
          data: {
            tenantId: tenant.id,
            credentialUserId,
            fullName: holder.fullName,
            phoneNumber: holder.phoneNumber,
            phoneVerifiedAt: holder.phoneVerifiedAt,
            roleId: role.id,
            status: 'active',
          },
          select: { id: true },
        });
        return ok({ userId: user.id }, 'tenant.ownerAccountReady');
      } catch (e: any) {
        if (e?.code !== 'P2002') throw e;
        const target: string[] = e?.meta?.target ?? [];
        if (target.includes('credentialUserId')) {
          const winner = await this.linkedTo(credentialUserId);
          if (winner) return ok({ userId: winner.id }, 'tenant.ownerAccountReady');
        }
        return err('tenant.ownerPhoneTaken');
      }
    });
  }

  private linkedTo(credentialUserId: string) {
    return this.prisma.user.findFirst({
      where: { credentialUserId },
      select: { id: true },
    });
  }
}
