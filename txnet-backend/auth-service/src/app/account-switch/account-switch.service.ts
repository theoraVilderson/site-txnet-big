import { Injectable, Logger } from '@nestjs/common';
import { SessionRevokedReason } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { SessionService } from '../auth/session/session.service';
import { OtpChannel } from '../auth/otp/otp.interface';
import { err, ok, safeExecute } from '../common/response/response.util';
import { SwitchScope } from '../common/security/switch-scope';
import {
  AddByOtpVerifyInput,
  AddByPasswordInput,
} from './account-switch.schema';

/**
 * What a member looks like on a page anyone standing behind the user can read
 * (F-0206). The full number is never sent: the list exists so the user can
 * tell their own accounts apart, and four digits does that.
 */
export type SwitchGroupMember = {
  userId: string;
  fullName: string;
  phoneMasked: string | null;
};

/** `09123456789` -> `0912***6789`. Null stays null — some accounts have none. */
function maskPhone(phoneNumber: string | null): string | null {
  if (!phoneNumber) return null;
  if (phoneNumber.length <= 8) return '***';
  return `${phoneNumber.slice(0, 4)}***${phoneNumber.slice(-4)}`;
}

/**
 * The user's own set of accounts **on one surface**, and the rules for getting
 * into it (F-0205).
 *
 * Since ADR-0015 a group belongs to the place it was built, not to the person:
 * `scopeKey` is one bot chat or one browser, and `(scopeKey, userId)` is what is
 * unique. Three accounts wired up inside a Telegram chat and two different ones
 * in a browser are two independent groups that happen to share a founder, and
 * neither is visible from the other. Every method here therefore takes the
 * caller's scope first — a lookup without one would be the old global behaviour
 * wearing a new signature.
 *
 * This is `audit`'s first service. The group is deliberately not part of
 * `identity`: it asserts nothing about who someone *is* — every member keeps
 * its own role, wallet, tenant and sessions — only that one human holds them
 * all. That statement is a trail of who may act as whom, which is what this
 * unit is for.
 *
 * Membership is proved, never asserted (audit invariant #4). Three proofs are
 * accepted and they are not interchangeable in strength order but in kind:
 *
 * - the **founder** proves their own account by the live session this request
 *   arrives on — it was itself minted by a password or an OTP;
 * - a joining account proves itself by a code sent to *its own* phone;
 * - or by its own password.
 *
 * What is never accepted is the caller simply naming an account. The whole
 * value of the group is that a switch afterwards costs no credential, so the
 * one moment a credential is demanded is this one.
 */
@Injectable()
export class AccountSwitchService {
  private readonly logger = new Logger(AccountSwitchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly sessionService: SessionService,
  ) {}

  /**
   * Send a proof code to the phone of the account being added.
   *
   * Answers `{accepted:true}` for any well-formed number, registered or not —
   * the caller has proven only their *own* identity, so branching here would
   * turn a signed-in session into an account-existence oracle (identity rule
   * 2's reasoning). May instead answer with a bot deep link when the chosen
   * messenger is not connected to that account yet (F-0203).
   */
  async requestAddOtp(
    callerUserId: string,
    phoneNumber: string,
    channel: OtpChannel | undefined,
    ip: string,
    lang: string,
  ) {
    return safeExecute(async () => {
      const caller = await this.activeCaller(callerUserId);
      if (!caller) return err('auth.invalidCredentials');

      // Adding yourself is the one refusal worth making early: it reveals
      // nothing (the caller already knows their own number) and letting it
      // reach the proof step would send a code for no reachable outcome.
      if (caller.phoneNumber === phoneNumber) {
        return err('accountSwitch.sameAccount');
      }

      const link = await this.auth.issueAccountProofOtp(
        phoneNumber,
        channel,
        ip,
        lang,
      );
      if (link) return link;
      return ok({ accepted: true }, 'accountSwitch.otpSent');
    });
  }

  /** Spend the proof code and join the caller's group **in this scope**. */
  async addByOtp(
    scopeKey: SwitchScope | null,
    callerUserId: string,
    input: AddByOtpVerifyInput,
  ) {
    return safeExecute(async () => {
      if (!scopeKey) return err('accountSwitch.noScope');
      const caller = await this.activeCaller(callerUserId);
      if (!caller) return err('auth.invalidCredentials');

      const target = await this.auth.proveAccountByOtp(
        input.phoneNumber,
        input.otpCode,
      );
      if (!target) return err('accountSwitch.proofFailed');

      return this.join(scopeKey, caller.id, target.id, true);
    });
  }

  /** Join by the account's own password instead of a code. */
  async addByPassword(
    scopeKey: SwitchScope | null,
    callerUserId: string,
    input: AddByPasswordInput,
  ) {
    return safeExecute(async () => {
      if (!scopeKey) return err('accountSwitch.noScope');
      const caller = await this.activeCaller(callerUserId);
      if (!caller) return err('auth.invalidCredentials');

      const target = await this.auth.proveAccountByPassword(
        input.identifier,
        input.password,
      );
      if (!target) return err('accountSwitch.proofFailed');

      return this.join(scopeKey, caller.id, target.id, false);
    });
  }

  // --- the group, once it exists -------------------------------------------

  /**
   * The caller's own account plus the members they may switch to (F-0206).
   *
   * Two filters, and the second one is the load-bearing one:
   *
   * - the caller is never in `members` — you do not switch to where you are;
   * - a member of another tenant is dropped. Membership records a *human* and
   *   may legitimately span tenants; the list may not (C-22, audit invariant
   *   #6). Each tenant is a separate white-label brand, so offering a
   *   cross-tenant member here would end with brand B's session live on brand
   *   A's domain.
   *
   * No group yet is a success, not an error: `members` is empty and the panel
   * renders "add an account". Since ADR-0015 that is also the *normal* answer
   * on a surface the user has not built a group on yet — a browser with three
   * accounts says nothing about what a chat can see.
   *
   * A request with no resolvable scope lists nothing rather than falling back
   * to a global read, which is the failure mode this whole change exists to
   * remove.
   */
  async list(scopeKey: SwitchScope | null, callerUserId: string) {
    return safeExecute(async () => {
      const caller = await this.activeCaller(callerUserId);
      if (!caller) return err('auth.invalidCredentials');

      const current = {
        userId: caller.id,
        fullName: caller.fullName,
        phoneMasked: maskPhone(caller.phoneNumber),
      };

      const membership = scopeKey
        ? await this.prisma.linkedAccountMember.findUnique({
            where: { scopeKey_userId: { scopeKey, userId: callerUserId } },
          })
        : null;
      if (!membership) {
        return ok(
          { groupId: null, current, members: [] as SwitchGroupMember[] },
          'accountSwitch.listed',
        );
      }

      const rows = await this.prisma.linkedAccountMember.findMany({
        where: { groupId: membership.groupId, userId: { not: callerUserId } },
        orderBy: { addedAt: 'asc' },
        select: { userId: true },
      });

      const users = await this.prisma.user.findMany({
        where: {
          id: { in: rows.map((row) => row.userId) },
          tenantId: caller.tenantId,
          status: 'active',
          deletedAt: null,
        },
        select: { id: true, fullName: true, phoneNumber: true },
      });

      // Ordered by when each account joined, which is the order the user built
      // the group in — `findMany` above answers in whatever order it likes.
      const byId = new Map(users.map((user) => [user.id, user]));
      const members: SwitchGroupMember[] = rows
        .map((row) => byId.get(row.userId))
        .filter((user): user is NonNullable<typeof user> => !!user)
        .map((user) => ({
          userId: user.id,
          fullName: user.fullName,
          phoneMasked: maskPhone(user.phoneNumber),
        }));

      return ok({ groupId: membership.groupId, current, members }, 'accountSwitch.listed');
    });
  }

  /**
   * Become another member of the group (F-0207).
   *
   * Everything this checks answers the same key, `accountSwitch.notAMember`:
   * not in a group, in a different group, in another tenant, deleted,
   * suspended. They are one question from the caller's side — "may I switch
   * here?" — and separating them would tell a caller holding one session
   * which arbitrary user ids exist and what state they are in.
   *
   * The session handover itself is identity's (`AuthService.switchSession`);
   * what is decided here is membership, which is this unit's whole job.
   */
  async switchTo(
    scopeKey: SwitchScope | null,
    callerUserId: string,
    callerSessionId: string,
    targetUserId: string,
    ip: string,
    userAgent: string,
  ) {
    return safeExecute(async () => {
      // No scope is not a member either — same key, for the same reason as
      // every other branch below.
      if (!scopeKey) return err('accountSwitch.notAMember');
      const caller = await this.activeCaller(callerUserId);
      if (!caller) return err('auth.invalidCredentials');
      if (caller.id === targetUserId) return err('accountSwitch.sameAccount');

      const [callerMembership, targetMembership] = await Promise.all([
        this.prisma.linkedAccountMember.findUnique({
          where: { scopeKey_userId: { scopeKey, userId: callerUserId } },
        }),
        this.prisma.linkedAccountMember.findUnique({
          where: { scopeKey_userId: { scopeKey, userId: targetUserId } },
        }),
      ]);
      if (
        !callerMembership ||
        !targetMembership ||
        callerMembership.groupId !== targetMembership.groupId
      ) {
        return err('accountSwitch.notAMember');
      }

      // The role and its permissions are what the new access token is signed
      // from, so the target is loaded the same way a login loads it. Nothing
      // is inherited from the outgoing account (F-0205's "the group is not a
      // shared identity").
      const target = await this.auth.findUserForSession(targetUserId);
      if (!target || target.deletedAt || target.status !== 'active') {
        return err('accountSwitch.notAMember');
      }
      if (target.tenantId !== caller.tenantId) {
        this.logger.warn(
          `account-switch: cross-tenant switch refused, caller=${callerUserId} target=${targetUserId}`,
        );
        return err('accountSwitch.notAMember');
      }

      const tokens = await this.auth.switchSession(
        callerSessionId,
        callerUserId,
        target,
        ip,
        userAgent,
        // The incoming session belongs to the surface the switch was made on,
        // which is the surface whose group allowed it (ADR-0015).
        scopeKey,
      );

      return ok(
        { userId: target.id, fullName: target.fullName, ...tokens },
        'accountSwitch.switched',
      );
    });
  }

  /**
   * Take an account out of the group on this surface (F-0208).
   *
   * **From either side**, which the spec asks for and which costs nothing to
   * honour here: a member of the group may remove any other member, and may
   * remove itself (leaving). Both are the same operation — the caller and the
   * target must simply share a group in this scope — because the group is a
   * set of accounts one human already proved they hold. There is no side with
   * more authority than the other, and inventing a "founder" who alone may
   * evict would give the first account a permanent veto over the others.
   *
   * Two things it deliberately does **not** do:
   *
   * - it does not touch other scopes. The row removed is `(scopeKey, userId)`
   *   and nothing else, so an account removed in a browser keeps whatever
   *   group it holds inside a chat (ADR-0015).
   * - it does not revoke the account's sessions everywhere. Only the sessions
   *   minted in *this* scope go, which is the narrow reading of F-0208's "on
   *   the way out" — see `revokeSessionsForUserInScope`. The reason to revoke
   *   at all is the case F-0208 names: a lost or recycled phone number, where
   *   a session on this surface is exactly what must not survive the removal.
   *
   * A group is torn down once it would be left with a single member: a group
   * of one is not a switcher, and leaving it standing means the next add finds
   * a stale group instead of creating a fresh one.
   */
  async remove(
    scopeKey: SwitchScope | null,
    callerUserId: string,
    targetUserId: string,
  ) {
    return safeExecute(async () => {
      if (!scopeKey) return err('accountSwitch.notAMember');
      const caller = await this.activeCaller(callerUserId);
      if (!caller) return err('auth.invalidCredentials');

      const [callerMembership, targetMembership] = await Promise.all([
        this.prisma.linkedAccountMember.findUnique({
          where: { scopeKey_userId: { scopeKey, userId: callerUserId } },
        }),
        this.prisma.linkedAccountMember.findUnique({
          where: { scopeKey_userId: { scopeKey, userId: targetUserId } },
        }),
      ]);

      // Same single key as `switchTo`, and for the same reason: not in a
      // group, not in *this* group, no such member. Separating them would let
      // a caller holding one session probe which user ids exist.
      if (
        !callerMembership ||
        !targetMembership ||
        callerMembership.groupId !== targetMembership.groupId
      ) {
        return err('accountSwitch.notAMember');
      }

      const groupId = targetMembership.groupId;

      await this.prisma.$transaction(async (tx) => {
        await tx.linkedAccountMember.delete({
          where: { id: targetMembership.id },
        });

        const left = await tx.linkedAccountMember.findMany({
          where: { groupId },
          select: { id: true },
        });
        if (left.length <= 1) {
          await tx.linkedAccountMember.deleteMany({ where: { groupId } });
          await tx.linkedAccountGroup.delete({ where: { id: groupId } });
        }
      });

      // After the row is gone, never before: a revoked session with the
      // membership still in place would leave the removed account signed out
      // *and* still listed, which is the one visibly broken intermediate
      // state this ordering avoids.
      const revoked = await this.sessionService.revokeSessionsForUserInScope(
        targetUserId,
        scopeKey,
        SessionRevokedReason.account_unlinked,
      );

      this.logger.log(
        `account-switch: user=${targetUserId} removed from group=${groupId} (scope=${scopeKey}) by caller=${callerUserId}, ${revoked} session(s) revoked`,
      );

      return ok({ userId: targetUserId, removed: true }, 'accountSwitch.removed');
    });
  }

  // --- the rule ------------------------------------------------------------

  /**
   * Put `targetUserId` in `callerUserId`'s group, creating the group on first
   * use. The proof has already happened; what is decided here is membership.
   *
   * One transaction, because a group whose founder row is missing is worse
   * than no group at all: the caller would not be in their own switcher, and
   * `userId` being unique means the repair is a delete, not an insert.
   */
  private async join(
    scopeKey: SwitchScope,
    callerUserId: string,
    targetUserId: string,
    verifiedViaOtp: boolean,
  ) {
    if (callerUserId === targetUserId) {
      return err('accountSwitch.sameAccount');
    }

    const [callerMembership, targetMembership] = await Promise.all([
      this.prisma.linkedAccountMember.findUnique({
        where: { scopeKey_userId: { scopeKey, userId: callerUserId } },
      }),
      this.prisma.linkedAccountMember.findUnique({
        where: { scopeKey_userId: { scopeKey, userId: targetUserId } },
      }),
    ]);

    if (targetMembership) {
      // Already in the caller's own group: the proof was spent for nothing,
      // but the end state is what was asked for, so this is a success.
      if (targetMembership.groupId === callerMembership?.groupId) {
        return ok(
          { groupId: targetMembership.groupId, added: false },
          'accountSwitch.added',
        );
      }
      // In someone else's group *on this same surface*. `(scopeKey, userId)`
      // is unique (audit invariant #3), so joining is still a move — and a
      // move here would silently take an account out of another person's
      // switcher. Refuse; F-0208 is how an account leaves a group, and it is
      // the other side's call. Note this is now a much narrower collision than
      // before ADR-0015: being in a group in a *different* scope is no
      // obstacle at all, which is the whole point of the change.
      this.logger.warn(
        `account-switch: user=${targetUserId} already in group=${targetMembership.groupId} (scope=${scopeKey}), refused for caller=${callerUserId}`,
      );
      return err('accountSwitch.alreadyInAnotherGroup');
    }

    const groupId = await this.prisma.$transaction(async (tx) => {
      if (callerMembership) {
        await tx.linkedAccountMember.create({
          data: {
            groupId: callerMembership.groupId,
            userId: targetUserId,
            // Inherited from the row that already exists rather than taken
            // from the argument, so the "one group, one scope" invariant is
            // held by construction even if the two ever disagreed.
            scopeKey: callerMembership.scopeKey,
            verifiedViaOtp,
          },
        });
        return callerMembership.groupId;
      }

      const group = await tx.linkedAccountGroup.create({ data: {} });
      await tx.linkedAccountMember.createMany({
        data: [
          // The founder. Its proof is the live session this request arrived
          // on, which is not an OTP — see audit invariants #4 on why the
          // boolean records only that question and never "unproved".
          { groupId: group.id, userId: callerUserId, scopeKey, verifiedViaOtp: false },
          { groupId: group.id, userId: targetUserId, scopeKey, verifiedViaOtp },
        ],
      });
      return group.id;
    });

    return ok({ groupId, added: true }, 'accountSwitch.added');
  }

  /** The caller's own row, or null if the account is no longer usable. */
  private async activeCaller(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        fullName: true,
        phoneNumber: true,
        // C-22: every list and every switch is filtered by this. It is
        // selected here rather than looked up again so there is one place the
        // caller's tenant comes from.
        tenantId: true,
        status: true,
        deletedAt: true,
      },
    });
    if (!user || user.deletedAt || user.status !== 'active') return null;
    return user;
  }
}
