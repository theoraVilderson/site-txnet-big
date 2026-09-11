import { Injectable, Logger } from '@nestjs/common';
import {
  BotClientRegistry,
  BotContact,
  BotPlatform,
} from '@txnet-backend/messenger';
import { PrismaService } from '../../prisma/prisma.service';
import { normalizeMessengerPhone } from './bot-link.service';
import { AuthService } from '../auth.service';
import { botScopeKey, SwitchScope } from '../../common/security/switch-scope';
import { TenantContext } from '../../tenant-context/tenant-context';

/**
 * Signing in with the messenger account itself (ADR-0012).
 *
 * A `LinkedBotAccount` with `contactVerifiedAt` set is not a step towards
 * proving something — it **is** the proof. It was established by a contact
 * card the platform itself vouched for (`contact.user_id === message.from.id`
 * plus a phone match, invariant #12), which is a stronger statement about who
 * controls that number than an SMS code is: no SIM swap, no SS7, no
 * interception.
 *
 * So a chat that holds one is authenticated, and the one-time code that used
 * to follow it was re-delivering a proof this service already held — through a
 * weaker channel, into the very chat that asked for it. Removing it takes
 * nothing away.
 *
 * **Scope (deliberate, and the safe polarity).** This factor signs in the
 * `user` role and nothing else. A Support/Admin/SuperAdmin account — and any
 * privileged role added after this was written — falls through to the ordinary
 * paths, because "whoever holds this person's Telegram holds their account" is
 * an acceptable trade for a customer and not for someone who can act on other
 * people's money. An allow-list, so a new role is safe before anyone thinks
 * about it.
 */
export const BOT_SESSION_ROLES: readonly string[] = ['user'];

/**
 * What a messenger-originated session is labelled as, when there is no device
 * to name (F-048).
 *
 * A bot webhook carries a chat id and a language code. It carries no user
 * agent, no client IP and nothing about the device, because the request
 * `auth-service` sees was made by `bot-service`, not by the person. Writing
 * that container's address into `Session.ipAddress` was worse than writing
 * nothing: every chat on the platform shared one address, and a session list
 * and an audit trail both read the column as a place the platform observed.
 *
 * So the honest pair is a null IP and this label. It buys no device data — the
 * platform genuinely has none here — it only stops the row claiming some.
 *
 * The `@username` suffix `F-048` mentions is deliberately not here: the
 * normalized update `messenger` hands over carries no sender username, and
 * plumbing one through four files for a label suffix costs more than it says.
 */
export const MESSENGER_DEVICE_LABEL: Record<BotPlatform, string> = {
  telegram: 'Telegram',
  bale: 'Bale',
};

/**
 * What the platform saw of the caller's device, or `null` when it saw nothing.
 *
 * `null` is not "unknown, fill in a default" — it is the answer. Only a caller
 * that is genuinely a browser (the Mini App) has a pair to pass.
 */
export type ObservedDevice = { ip: string; userAgent: string } | null;

export type BotSessionOutcome =
  | {
      state: 'authenticated';
      tokens: { accessToken: string; refreshToken: string; expiresIn: number };
    }
  /** No link yet: the chat must share its contact card before anything else. */
  | { state: 'needsContact' }
  | { state: 'refused'; key: string };

@Injectable()
export class BotSessionService {
  private readonly logger = new Logger(BotSessionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly bots: BotClientRegistry,
  ) {}

  /**
   * The same sign-in, asked for from inside the Mini App (`F-310`, ADR-0018).
   *
   * The chat is not on the line here — a browser in a webview is — so the
   * proof arrives as `initData`, a string the platform signed with the bot's
   * own token. Verifying it says *which messenger account* is looking at the
   * page, and that is the identical fact a chat id carries on the route above:
   * for a private chat both are the same platform user id, which is what
   * `LinkedBotAccount.platformUserId` holds. Everything after that point —
   * the link must be contact-verified, the account must be live, the role
   * must be on the allow-list — is `authenticate`'s, unchanged.
   *
   * Two things are deliberately *not* shared with the chat route:
   *
   * - **No contact card.** A Mini App has no way to ask for one, so a chat
   *   that has never shared its number gets `needsContact` and is sent back to
   *   the conversation, where that question already has a screen.
   * - **The scope is the chat's** (ADR-0032), taken from the same verified
   *   `initData` and never from the webview's `device_id` cookie. The Mini App
   *   is not another place with another audience: it is the chat, opened as a
   *   webview, so an account added in one belongs to the other. Its later
   *   calls agree because an authenticated request now takes its scope from
   *   the session it is holding rather than re-deriving it (`AuthGuard`).
   */
  async authenticateWebApp(
    input: { platform: BotPlatform; initData: string },
    observed: ObservedDevice,
  ): Promise<BotSessionOutcome> {
    const integration = await this.bots.primaryFor(
      TenantContext.current('a mini app session').id,
      input.platform,
    );
    const verified = integration
      ? await this.bots.verifyWebAppInitData(integration, input.initData)
      : ({ ok: false, reason: 'malformed' } as const);
    if (!verified.ok) {
      // One refusal for every reason: a forged signature, a replayed one and
      // an unconfigured bot are the same answer to whoever is asking, and the
      // log is where they are told apart.
      this.logger.warn(
        `${input.platform}: mini app initData rejected — ${verified.reason}`,
      );
      return { state: 'refused', key: 'auth.invalidCredentials' };
    }

    const chatId = verified.data.user.id;
    return this.authenticate(
      { platform: input.platform, chatId },
      observed,
      botScopeKey(input.platform, chatId),
    );
  }

  /**
   * Authenticate a chat, linking it first if a contact card came with the
   * request.
   *
   * `observed` is `null` on the chat route and a real pair only from the Mini
   * App, where the caller actually is a browser (F-048). Either way the
   * session is labelled with the messenger it came from, because that is the
   * one true thing about the device on both paths.
   */
  async authenticate(
    input: {
      platform: BotPlatform;
      chatId: string;
      senderId?: string | number;
      contact?: BotContact;
    },
    observed: ObservedDevice,
    scope?: SwitchScope | null,
  ): Promise<BotSessionOutcome> {
    const linked = await this.linkedUser(input.platform, input.chatId);
    const user = linked ?? (await this.linkNow(input));

    if (user === 'needsContact') return { state: 'needsContact' };
    if (typeof user === 'string') return { state: 'refused', key: user };

    // The same order password login answers in (invariant #12): nothing about
    // an account is said before the caller has proven anything. Here the proof
    // came first, so these are simply the account's own conditions.
    if (user.deletedAt || user.status !== 'active') {
      return { state: 'refused', key: 'auth.invalidCredentials' };
    }
    if (!user.phoneVerifiedAt) {
      return { state: 'refused', key: 'auth.phoneVerificationRequired' };
    }
    if (!BOT_SESSION_ROLES.includes(user.role?.name)) {
      this.logger.warn(
        `${input.platform}: chat=${input.chatId} holds role ${user.role?.name} — bot factor refused`,
      );
      return { state: 'refused', key: 'auth.botFactorNotAllowed' };
    }

    // ADR-0034: this place may be acting as another member of its group.
    // Only an *implicit* sign-in consults it — here, where the messenger link
    // is the credential (ADR-0012) and the caller named no account. A password
    // login names its account and is never redirected.
    const acting = await this.actingAs(
      scope ?? botScopeKey(input.platform, input.chatId),
      user.id,
    );

    // The scope is derived from the input rather than from the request
    // headers (ADR-0015): this call already names the chat it is signing in,
    // and that is exactly the switch scope. Reading `x-bot-platform` here
    // instead would make a one-tap sign-in depend on a header that says the
    // same thing the body already does. Both callers land on the same key —
    // `authenticateWebApp` passes the chat named by the signature it just
    // verified (ADR-0032), so the Mini App and the chat share one group.
    const tokens = await this.auth.createSessionForUser(
      acting ?? user,
      observed?.ip ?? null,
      observed?.userAgent ?? null,
      scope ?? botScopeKey(input.platform, input.chatId),
      MESSENGER_DEVICE_LABEL[input.platform],
    );
    return { state: 'authenticated', tokens };
  }

  /**
   * The member this place is currently acting as, or `null` for "itself".
   *
   * Three things have to hold before a pointer is honoured, and each is a way
   * it could otherwise become an authentication of its own:
   *
   * - the linked account must still be a member of a group **in this scope**,
   *   because that group is the only thing the pointer is scoped by;
   * - the pointer must name someone still in that same group here — an
   *   `F-0208` removal leaves the pointer behind on purpose (it is not a
   *   membership record), so a stale one must resolve to nothing;
   * - the target must load and pass the same conditions any sign-in applies.
   *
   * Any of them failing falls back to the linked account, which is exactly
   * ADR-0014's behaviour and never an error: "this place has not switched, or
   * cannot any more" and "sign in as the linked account" are one answer.
   */
  private async actingAs(scopeKey: SwitchScope, linkedUserId: string) {
    const membership = await this.prisma.linkedAccountMember.findUnique({
      where: { scopeKey_userId: { scopeKey, userId: linkedUserId } },
      select: { groupId: true, group: { select: { actingAsUserId: true } } },
    });
    const target = membership?.group?.actingAsUserId;
    if (!target || target === linkedUserId) return null;

    const stillAMember = await this.prisma.linkedAccountMember.findFirst({
      where: { scopeKey, userId: target, groupId: membership.groupId },
      select: { id: true },
    });
    if (!stillAMember) return null;

    const user = await this.prisma.user.findUnique({
      where: { id: target },
      include: {
        role: {
          include: { rolePermissions: { include: { permission: true } } },
        },
      },
    });
    if (!user || user.deletedAt || user.status !== 'active') return null;
    if (!user.phoneVerifiedAt) return null;
    if (!BOT_SESSION_ROLES.includes(user.role?.name)) return null;
    return user;
  }

  /** The account this chat has already proven it belongs to, if any. */
  private async linkedUser(platform: BotPlatform, chatId: string) {
    const link = await this.prisma.linkedBotAccount.findFirst({
      where: {
        platform,
        platformUserId: chatId,
        contactVerifiedAt: { not: null },
      },
      select: { userId: true },
    });
    if (!link) return null;
    return this.prisma.user.findUnique({
      where: { id: link.userId },
      include: {
        role: {
          include: { rolePermissions: { include: { permission: true } } },
        },
      },
    });
  }

  /**
   * No link yet. A contact card can create one on the spot — and this is the
   * one place a link is not anchored to a phone number typed in beforehand,
   * because the card *carries* the number and the platform vouches for it.
   *
   * The proof is exactly invariant #12's: the card must describe the person
   * who sent it. What differs is only which end is known first — there, a
   * phone looking for its chat; here, a chat presenting its phone.
   */
  private async linkNow(input: {
    platform: BotPlatform;
    chatId: string;
    senderId?: string | number;
    contact?: BotContact;
  }) {
    const { platform, chatId, senderId, contact } = input;
    if (!contact) return 'needsContact' as const;

    if (!contact.user_id || String(contact.user_id) !== String(senderId)) {
      this.logger.warn(
        `${platform}: contact sent by ${senderId} describes ${contact.user_id ?? 'nobody'} — rejected`,
      );
      return 'otp.botLink.senderMismatch';
    }

    const phoneNumber = normalizeMessengerPhone(contact.phone_number);
    if (!phoneNumber) return 'otp.botLink.phoneMismatch';

    const user = await this.prisma.user.findFirst({
      where: { phoneNumber, deletedAt: null },
      include: {
        role: {
          include: { rolePermissions: { include: { permission: true } } },
        },
      },
    });
    // Saying "no account" here reveals nothing: the sender has just proven
    // this number is theirs, so they could establish the same by trying to
    // register with it. `BotLinkService.handleContact` answers the same way
    // for the same reason.
    if (!user) return 'otp.botLink.noAccount';

    // One messenger account, one platform account.
    const takenBySomeoneElse = await this.prisma.linkedBotAccount.findFirst({
      where: { platform, platformUserId: chatId, userId: { not: user.id } },
      select: { id: true },
    });
    if (takenBySomeoneElse) return 'otp.botLink.takenByAnotherAccount';

    await this.prisma.linkedBotAccount.upsert({
      where: { userId_platform: { userId: user.id, platform } },
      create: {
        tenantId: TenantContext.current('a bot link').id,
        userId: user.id,
        platform,
        platformUserId: chatId,
        phoneNumber,
        contactVerifiedAt: new Date(),
      },
      update: {
        platformUserId: chatId,
        phoneNumber,
        contactVerifiedAt: new Date(),
      },
    });
    return user;
  }
}
