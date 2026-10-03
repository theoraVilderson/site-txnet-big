import { createHash } from 'node:crypto';

import { FingerprintChannel, Prisma } from '@prisma/client';
import { DEVICE_ID_COOKIE, IdentityHeaders, headerValue } from '@txnet-backend/shared-core';

/**
 * The device fingerprint (F-036-a, D-11; ADR-0111 point 3).
 *
 * D-11's recipe, channel-agnostic and with no client-side library: a browser is
 * its address, its User-Agent and the server-minted `device_id` cookie; a
 * messenger account is its platform and its id there. A bot's address and
 * agent are bot-service's, the same for every chat, so they are not part of it.
 *
 * The fingerprint is a signal, not an identity. It counts the distinct accounts
 * seen in one place over 30 days: 3 raises a flag (F-036), 5 refuses free
 * grants — the trial, the wheel — and never login or a purchase.
 */
export type FingerprintSource =
  | { channel: typeof FingerprintChannel.web; ip: string; userAgent: string; deviceId: string }
  | { channel: typeof FingerprintChannel.bot; platform: string; platformUserId: string };

export const FINGERPRINT_WINDOW_DAYS = 30;
/** Accounts in the window that raise a `fraud_flag` (D-11). */
export const FINGERPRINT_FLAG_AT = 3;
/** Accounts in the window that refuse a free grant (D-11). */
export const FINGERPRINT_FREE_GRANTS_REFUSED_AT = 5;

export type FingerprintVerdict = 'clear' | 'flag' | 'refuse_free_grants';

/**
 * sha256 over the components as a JSON array, so no value can run into its
 * neighbour: joined with a separator, `("a|b", "c")` and `("a", "b|c")` are one
 * string. The channel leads, so a browser and a chat never share a hash.
 */
export function fingerprintHash(source: FingerprintSource): string {
  const parts =
    source.channel === FingerprintChannel.web
      ? [source.channel, source.ip, source.userAgent, source.deviceId]
      : [source.channel, source.platform, source.platformUserId];
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/** One cookie off the raw header; billing installs no cookie parser. */
function cookieValue(header: string | undefined, name: string): string | undefined {
  const part = header?.split(';').map((p) => p.trim()).find((p) => p.startsWith(`${name}=`));
  const value = part ? decodeURIComponent(part.slice(name.length + 1)) : undefined;
  return value || undefined;
}

/**
 * Where this request came from, or `null` when it cannot be told — and then
 * the caller refuses what needs a fingerprint rather than recording a blank.
 *
 * A chat session is the messenger account the gate names (`X-Chat-Platform`,
 * `X-Chat-User-Id`: written by the gate, stripped from what the client sent).
 * Anything else is a browser, and needs the `device_id` cookie auth-service
 * mints on its first request; `ip` is Express's, so `trust proxy` must be set.
 */
export function fingerprintSourceOf(req: { ip?: string; headers: Record<string, string | string[] | undefined> }): FingerprintSource | null {
  const platform = headerValue(req.headers, IdentityHeaders.chatPlatform);
  const platformUserId = headerValue(req.headers, IdentityHeaders.chatUserId);
  if (platform && platformUserId) return { channel: FingerprintChannel.bot, platform, platformUserId };

  const cookie = headerValue(req.headers, 'cookie');
  const deviceId = cookieValue(cookie, DEVICE_ID_COOKIE);
  if (!deviceId || !req.ip) return null;
  return { channel: FingerprintChannel.web, ip: req.ip, userAgent: headerValue(req.headers, 'user-agent') ?? '', deviceId };
}

export function fingerprintVerdict(accounts: number): FingerprintVerdict {
  if (accounts >= FINGERPRINT_FREE_GRANTS_REFUSED_AT) return 'refuse_free_grants';
  if (accounts >= FINGERPRINT_FLAG_AT) return 'flag';
  return 'clear';
}

/**
 * Records a sighting of this account in this place, in the caller's
 * transaction (one row per tenant, account and fingerprint; `lastSeenAt`
 * moves). The id is what a spin attempt names (`spin_wheel_attempt`).
 */
export async function recordFingerprint(
  tx: Prisma.TransactionClient,
  input: { tenantId: string; userId: string; source: FingerprintSource; at: Date },
): Promise<{ id: string; fingerprintHash: string }> {
  const hash = fingerprintHash(input.source);
  return tx.deviceFingerprint.upsert({
    where: { tenantId_userId_fingerprintHash: { tenantId: input.tenantId, userId: input.userId, fingerprintHash: hash } },
    create: { tenantId: input.tenantId, userId: input.userId, channel: input.source.channel, fingerprintHash: hash, lastSeenAt: input.at },
    update: { lastSeenAt: input.at },
    select: { id: true, fingerprintHash: true },
  });
}

/** Distinct accounts of this tenant seen with this fingerprint in the last 30 days, `at` included. */
export async function accountsOnFingerprint(
  tx: Prisma.TransactionClient,
  input: { tenantId: string; fingerprintHash: string; at: Date },
): Promise<number> {
  const since = new Date(input.at.getTime() - FINGERPRINT_WINDOW_DAYS * 86_400_000);
  const accounts = await tx.deviceFingerprint.findMany({
    where: { tenantId: input.tenantId, fingerprintHash: input.fingerprintHash, lastSeenAt: { gte: since } },
    distinct: ['userId'],
    select: { userId: true },
  });
  return accounts.length;
}
