import { ConfigProtocol, GrantSource, type DriverType, type MigrationSkipReason } from '@prisma/client';
import { z } from 'zod';

/** A source panel's free text is bounded before anything keeps it (catalog §16: adversarial input). */
const REMOTE_ID_MAX = 200;
const LABEL_MAX = 200;
const UUID_MAX = 128;
const PROTOCOL_MAX = 64;
const LINE_MAX = 8192;
/** Most families answer one or two lines a client; a source answering more is not read further. */
const LINES_MAX = 64;
const bytes = z.number().int().nonnegative();

/**
 * One source client as network-service's snapshot answers it (F-201-b,
 * contract.source.md), parsed — never trusted — at the edge that reads it.
 */
export const sourceClientSchema = z.object({
  remoteId: z.string().min(1).max(REMOTE_ID_MAX),
  label: z.string().max(LABEL_MAX),
  uuid: z.string().max(UUID_MAX),
  inboundRemoteId: z.string().max(REMOTE_ID_MAX),
  protocol: z.string().max(PROTOCOL_MAX),
  enabled: z.boolean(),
  dataLimitBytes: bytes,
  upBytes: bytes,
  downBytes: bytes,
  expiresAt: z
    .string()
    .datetime({ offset: true })
    .transform((at) => new Date(at))
    .nullable(),
  lines: z.array(z.string().max(LINE_MAX)).max(LINES_MAX),
  linesRead: z.boolean(),
});
export type SourceClient = z.infer<typeof sourceClientSchema>;

/**
 * The run's source, the prepaid variant the reseller chose for this client's
 * inbound (a product, not a server — user, 2026-10-21) and the moment of the plan.
 */
export type MigrationSource = { family: DriverType; sourceAddress: string; variantId: string; now: Date };

/** What an import would issue for one client (F-202); the commit (F-207) issues it. */
export type PlannedImport = {
  remoteIdentity: string;
  skipReason?: undefined;
  /** F-201-e makes the username of it. */
  user: { label: string };
  grant: { source: typeof GrantSource.migration; startsAt: Date; endsAt: Date | null; trafficUnlimited: boolean; purchasedBytes: bigint; consumedBytes: bigint };
  /**
   * Placed by the variant's group, as any Grant of it (F-027-bl): the protocol
   * is the client's, for the report. `uuid` null where the list did not read
   * it (S-UI from v1.1).
   */
  config: { variantId: string; protocol: ConfigProtocol; uuid: string | null };
  /** The source's own on/off, kept apart from the Grant's status: a client disabled there is not a suspended Grant here. */
  enabled: boolean;
};
export type SkippedImport = { remoteIdentity: string; skipReason: Extract<MigrationSkipReason, 'expired' | 'unknown_protocol'>; user?: undefined; grant?: undefined; config?: undefined; enabled?: undefined };
export type MigrationItemPlan = PlannedImport | SkippedImport;

/**
 * The import's idempotency key (invariant 32): the family, the source's origin
 * and the client's id there — the same on every run of that panel, apart from
 * another panel's client of the same name. The id is last and the first two
 * hold no `|`, so it reads back unambiguously. A panel that moved to a new
 * address is a new source.
 */
export function remoteIdentityOf(source: Pick<MigrationSource, 'family' | 'sourceAddress'>, remoteId: string): string {
  return `${source.family}|${source.sourceAddress}|${remoteId}`;
}

const SOLD_PROTOCOLS: ReadonlySet<string> = new Set(Object.values(ConfigProtocol));
const isSold = (name: string): name is ConfigProtocol => SOLD_PROTOCOLS.has(name);

/** Our protocol for the source's name of it, or null for one we do not sell (`naive`, `shadowtls`, `socks`). */
function protocolOf(name: string): ConfigProtocol | null {
  const normalised = name.trim().toLowerCase();
  return isSold(normalised) ? normalised : null;
}

/**
 * One source client to what an import would issue (F-202, contract.import.md):
 * a user named from its label, a `migration` Grant from now to the client's
 * end with its quota as the bag (0 there is unlimited, as in every family)
 * and its upload plus download as consumed, and a config of its protocol from
 * the variant chosen for its inbound. Pure: a client already imported (update),
 * a duplicate and the reseller's cap are the dry run's (F-206), which knows
 * the run; what is skipped here is what the client alone says — an end that
 * has passed, a protocol we do not sell.
 */
export function planMigrationItem(client: SourceClient, source: MigrationSource): MigrationItemPlan {
  const remoteIdentity = remoteIdentityOf(source, client.remoteId);
  if (client.expiresAt && client.expiresAt.getTime() <= source.now.getTime()) return { remoteIdentity, skipReason: 'expired' };
  const protocol = protocolOf(client.protocol);
  if (!protocol) return { remoteIdentity, skipReason: 'unknown_protocol' };
  const trafficUnlimited = client.dataLimitBytes === 0;
  return {
    remoteIdentity,
    user: { label: client.label.trim() || client.remoteId },
    grant: {
      source: GrantSource.migration,
      startsAt: source.now,
      endsAt: client.expiresAt,
      trafficUnlimited,
      // `grant_traffic_unlimited_is_prepaid`: an unlimited Grant's bag is 0.
      purchasedBytes: trafficUnlimited ? BigInt(0) : BigInt(client.dataLimitBytes),
      consumedBytes: BigInt(client.upBytes) + BigInt(client.downBytes),
    },
    config: { variantId: source.variantId, protocol, uuid: client.uuid || null },
    enabled: client.enabled,
  };
}
