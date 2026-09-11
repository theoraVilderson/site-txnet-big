import { RealtimeChannelFamily } from '@txnet-backend/shared-core';
import { timingSafeEqual } from 'node:crypto';

/**
 * Channel names, and who is allowed to hear one (F-067-h, F-067-j).
 *
 * This file is the security surface of the realtime gateway. A connection is
 * admitted once, at the upgrade, by the same `forward-auth` gate that answers
 * for every other request — after that the socket is a pipe the client chooses
 * what flows through, and *this* is where that choice is refused. A channel is
 * a string a caller sends, so it is parsed exactly and matched against what
 * the connection can actually show; anything that does not parse is refused
 * rather than interpreted.
 *
 * **Since ADR-0031 a connection may be anonymous**, and that is why this file
 * carries more weight than it used to. The gate now admits a caller with no
 * credential, because a WebSocket on this platform is the live-data transport
 * and is opened before anyone signs in. An anonymous connection proves nothing
 * at the upgrade, so a channel it may hear has to be one it can prove per
 * subscription — which is the second of the two rules below.
 *
 * Fail closed, deliberately and in that order: an unknown prefix is not a
 * channel, not "a channel with no rule yet". A future family gets a case here
 * or it does not exist.
 */

/** The identity `forward-auth` proved at the upgrade. `null` when anonymous. */
export interface ConnectionIdentity {
  userId: string;
  tenantId: string;
  sessionId: string;
  permissions: readonly string[];
}

/**
 * The secrets a connection can present to earn a channel no identity covers.
 *
 * An interface rather than a Redis call because this file is the one place the
 * rule lives and it has to stay testable without a store. The gateway supplies
 * the real reader; the shape is the seam.
 */
export interface ChannelProofs {
  /**
   * The token minted alongside one OTP delivery, or `null` when the id was
   * never minted or its TTL has passed. The two are deliberately the same
   * answer — see the `otp:` case below.
   */
  otpChannelToken(channelId: string): Promise<string | null>;
}

/** One subscription request, as it arrives off the wire. */
export interface ChannelRequest {
  /** What the gate proved, or `null` for an anonymous connection. */
  identity: ConnectionIdentity | null;
  channel: string;
  /** The `proof` field of the `subscribe` frame, if the client sent one. */
  proof: string | null;
}

/**
 * The permission a tenant-wide channel needs. A tenant channel carries events
 * about *other people* in the reseller — it is an operator's view, not a
 * user's — so membership of the tenant is not enough on its own. Every
 * `user:` channel is scoped to one person and needs no permission at all.
 */
export const TENANT_CHANNEL_PERMISSION = 'realtime.tenant.read';

/**
 * What an OTP channel id looks like. 16 random bytes, hex, minted by
 * `OtpDeliveryStore` — the same shape and the same entropy as a delivery id.
 *
 * Checked before the store is asked anything. The `otp:` family is the only
 * one whose authorization touches the network, so a name that could not be an
 * id has to be refused here; otherwise a client picks how many Redis reads
 * this process does by sending nonsense.
 */
const OTP_CHANNEL_ID = /^[0-9a-f]{32}$/;

export type ChannelRefusal =
  /** The name matches no family this gateway serves. */
  | 'realtime.channelUnknown'
  /** A well-formed name this connection cannot show a claim to. */
  | 'realtime.channelForbidden';

/**
 * Why may this connection **not** subscribe to this channel? `null` means it
 * may.
 *
 * A nullable refusal rather than a two-armed result on purpose: this
 * workspace compiles without `strictNullChecks`, so a discriminated union
 * would not narrow and every caller would need a cast. The shape that reads
 * correctly under the compiler the repo actually uses is the honest one, and
 * it matches `trySubscribe`, the only caller.
 *
 * The three families, and why each is shaped the way it is:
 *
 * - `user:<userId>` — the one channel a signed-in page always wants. It is
 *   compared against the connection's own `userId` and nothing else: not the
 *   tenant, not a permission. An admin with every permission in the platform
 *   still cannot listen to another person's socket traffic here, because a
 *   permission that could grant that would make impersonation invisible —
 *   `audit` exists precisely so that acting as someone else leaves a row.
 *
 * - `tenant:<tenantId>` — the reseller-wide feed, behind
 *   `TENANT_CHANNEL_PERMISSION` *and* an exact tenant match. Both halves are
 *   load-bearing: the permission without the match would let a permitted
 *   operator at one reseller name another reseller's id, which is the tenancy
 *   boundary (ADR-0023) and the most expensive thing on this list to get
 *   wrong.
 *
 * - `otp:<channelId>` — the delivery result of one OTP send (F-067-j), and
 *   the only family authorized by a **proof rather than an identity**. It has
 *   to be: the three routes that issue an OTP are `register`, `login` and
 *   `password/forgot`, and by definition nobody is signed in at any of them.
 *   The claim is the token minted with the delivery, which the 202 handed to
 *   the one client that asked. Identity is not consulted at all — a signed-in
 *   connection holding the token is as entitled as an anonymous one, and a
 *   signed-in connection without it is not entitled at all.
 *
 * The first two refuse an anonymous connection by construction: there is no
 * id to match, and "no id" must never compare equal to a channel's.
 *
 * A name with no colon, an empty id, or an unknown prefix is
 * `realtime.channelUnknown` — the caller is told the shape is wrong, never
 * whether the thing it named exists.
 */
export async function channelRefusal(
  request: ChannelRequest,
  proofs: ChannelProofs,
): Promise<ChannelRefusal | null> {
  const { identity, channel, proof } = request;

  const separator = channel.indexOf(':');
  if (separator <= 0) return 'realtime.channelUnknown';

  const family = channel.slice(0, separator);
  const id = channel.slice(separator + 1);
  if (id === '') return 'realtime.channelUnknown';

  switch (family) {
    case RealtimeChannelFamily.user:
      if (!identity) return 'realtime.channelForbidden';
      return id === identity.userId ? null : 'realtime.channelForbidden';

    case RealtimeChannelFamily.tenant:
      if (!identity) return 'realtime.channelForbidden';
      return id === identity.tenantId &&
        identity.permissions.includes(TENANT_CHANNEL_PERMISSION)
        ? null
        : 'realtime.channelForbidden';

    case RealtimeChannelFamily.otp: {
      if (!proof || !OTP_CHANNEL_ID.test(id)) {
        return 'realtime.channelForbidden';
      }
      const expected = await proofs.otpChannelToken(id);
      // An expired channel and one nobody ever minted are the same refusal,
      // for the reason the status route answers `queued` to both: the OTP
      // routes mint an id whether or not a code was really issued, so any
      // answer that distinguished them would restate the account existence
      // those routes exist to refuse.
      if (!expected) return 'realtime.channelForbidden';
      return equalSecrets(proof, expected) ? null : 'realtime.channelForbidden';
    }

    default:
      return 'realtime.channelUnknown';
  }
}

/**
 * Compare two secrets without leaking their contents through timing.
 *
 * `timingSafeEqual` **throws** on buffers of different lengths, and the length
 * here is chosen by the client — so the guard is not defensive tidiness, it is
 * what stops a five-character proof from being a way to raise an exception
 * inside the authorization path. A length mismatch is simply not equal;
 * nothing about it needs to be constant time, because the length of a rejected
 * guess is something the attacker already knows.
 */
function equalSecrets(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
