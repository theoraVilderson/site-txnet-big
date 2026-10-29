import { DriverType } from '@prisma/client';
import { z } from 'zod';

import { panelAddressSchema, panelLoginSchema, panelNameSchema } from '../systems/panel-registration.schema';
import { BALANCE_FILE_MAX_CHARS } from '../wallet/balance-import';
import { legacyPathOf } from './legacy-sub-link';

/** A source inbound's id, as the snapshot answers it (`sourceClientSchema.inboundRemoteId`). */
const INBOUND_ID_MAX = 200;
/** A source panel holds a handful of inbounds; a mapping past this is not one. */
const INBOUNDS_PER_MAPPING_MAX = 200;

/** An absolute http(s) address, kept as its origin: the run's half of the import key (`remoteIdentityOf`). */
const originSchema = z
  .string()
  .trim()
  .max(2048)
  // `canParse` first: a refine still runs on a value an earlier check found dirty.
  .refine((u) => URL.canParse(u) && /^https?:$/.test(new URL(u).protocol), 'an absolute http(s) address')
  .transform((u) => new URL(u).origin);

/**
 * `POST …/migration-runs` (F-206): a whole source panel. Its family is any
 * driver; network-service answers one it cannot read as `bad_request`, and
 * the preview says so. The address is the origin only — the web path is the
 * login's, sealed in the vault (tenant `contract.source-login.md` rule 1).
 * A family imported in place names the tenant's registered panel instead
 * (ADR-0160, F-1601-b1): its address and login are the panel's own.
 */
export const migrationRunCreateSchema = z
  .object({ family: z.nativeEnum(DriverType), sourceAddress: originSchema.optional(), panelId: z.string().uuid().optional() })
  .strict()
  .refine((b) => (b.sourceAddress === undefined) !== (b.panelId === undefined), 'an address or a registered panel, not both');
export type MigrationRunCreate = z.infer<typeof migrationRunCreateSchema>;

/**
 * `PUT …/migration-runs/:runId/inbounds`: each source inbound to one of the
 * reseller's prepaid variants, null while undecided, or `skip` — not imported
 * at all (LIVE-1-h), which never names a variant.
 */
const inboundChoiceSchema = z
  .object({ inboundRemoteId: z.string().min(1).max(INBOUND_ID_MAX), variantId: z.string().uuid().nullable(), skip: z.boolean().optional() })
  .strict()
  .refine((c) => !(c.skip && c.variantId !== null), 'a skipped inbound names no variant');

export const migrationInboundsSchema = z
  .object({
    inbounds: z
      .array(inboundChoiceSchema)
      .min(1)
      .max(INBOUNDS_PER_MAPPING_MAX),
  })
  .strict();
export type MigrationInbounds = z.infer<typeof migrationInboundsSchema>;

/** A host name's longest form (RFC 1035). */
const HOST_MAX = 253;

/** `POST …/migration-runs/legacy-hosts/test` (F-204-b): one of the reseller's old hosts, as the page lists it. */
export const legacyHostTestSchema = z.object({ host: z.string().trim().min(1).max(HOST_MAX) }).strict();
export type LegacyHostTest = z.infer<typeof legacyHostTestSchema>;

/** The longest link kept, as the snapshot bounds a client's `subscriptionUrl`. */
const LINK_MAX = 2048;

/**
 * One old subscription link (F-201-g): absolute http(s) with a path — the
 * bare root is nobody's link (`legacyPathOf`). Kept whole: the path is the
 * old token the dry run reads with and the old link that keeps answering.
 */
export const oldLinkSchema = z
  .string()
  .trim()
  .max(LINK_MAX)
  .refine((u) => URL.canParse(u) && legacyPathOf(u) !== null, 'an absolute http(s) subscription link');

/** `POST …/migration-runs` (F-201-g): one person's import from their old link, beside a panel's body. */
export const migrationLinkRunCreateSchema = z.object({ url: oldLinkSchema, userId: z.string().uuid() }).strict();
export type MigrationLinkRunCreate = z.infer<typeof migrationLinkRunCreateSchema>;

/** `POST …/migration-runs` (F-209-a): a reseller's balances, the file's text as the page read it. Its rows are judged by the dry run. */
export const migrationCsvRunCreateSchema = z.object({ csv: z.string().min(1).max(BALANCE_FILE_MAX_CHARS) }).strict();
export type MigrationCsvRunCreate = z.infer<typeof migrationCsvRunCreateSchema>;

/** The create's body: a whole panel, one link or a balance file, told apart by their fields. */
export const migrationAnyRunCreateSchema = z.union([migrationRunCreateSchema, migrationLinkRunCreateSchema, migrationCsvRunCreateSchema]);
export type MigrationAnyRunCreate = z.infer<typeof migrationAnyRunCreateSchema>;

/** The create's body names one link (F-201-g), not a panel. */
export const isLinkRunCreate = (body: MigrationAnyRunCreate): body is MigrationLinkRunCreate => 'url' in body && typeof body.url === 'string';

/** The create's body is a balance file (F-209-a). */
export const isCsvRunCreate = (body: MigrationAnyRunCreate): body is MigrationCsvRunCreate => 'csv' in body && typeof body.csv === 'string';

const correctedBytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional();

/**
 * `PUT …/migration-runs/:runId/link` (F-201-g): the admin's word over what the
 * link said. A field left out keeps its value; null clears it (the read
 * figure stands again, or no product is chosen).
 */
export const migrationLinkCorrectionSchema = z
  .object({
    variantId: z.string().uuid().nullable().optional(),
    dataLimitBytes: correctedBytes,
    usedBytes: correctedBytes,
    expiresAt: z
      .string()
      .datetime({ offset: true })
      .transform((at) => new Date(at))
      .nullable()
      .optional(),
  })
  .strict()
  .refine((c) => Object.keys(c).length > 0, 'at least one field');
export type MigrationLinkCorrection = z.infer<typeof migrationLinkCorrectionSchema>;

/**
 * `POST …/migration-runs/routers` (F-1601-g, ADR-0162): a reseller's own
 * router, by the systems page's field rules. `.strict()`: the transport,
 * counting, owner and review are the family's and the test's to set, never
 * the body's.
 */
export const migrationRouterSchema = z
  .object({ family: z.nativeEnum(DriverType), name: panelNameSchema, apiBaseUrl: panelAddressSchema, credentials: panelLoginSchema })
  .strict();
export type MigrationRouterBody = z.infer<typeof migrationRouterSchema>;
