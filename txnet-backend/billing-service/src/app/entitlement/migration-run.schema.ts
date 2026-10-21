import { DriverType } from '@prisma/client';
import { z } from 'zod';

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
 */
export const migrationRunCreateSchema = z.object({ family: z.nativeEnum(DriverType), sourceAddress: originSchema }).strict();
export type MigrationRunCreate = z.infer<typeof migrationRunCreateSchema>;

/** `PUT …/migration-runs/:runId/inbounds`: each source inbound to one of the reseller's prepaid variants, or none. */
export const migrationInboundsSchema = z
  .object({
    inbounds: z
      .array(z.object({ inboundRemoteId: z.string().min(1).max(INBOUND_ID_MAX), variantId: z.string().uuid().nullable() }).strict())
      .min(1)
      .max(INBOUNDS_PER_MAPPING_MAX),
  })
  .strict();
export type MigrationInbounds = z.infer<typeof migrationInboundsSchema>;
