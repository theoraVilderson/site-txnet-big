import { isIanaZone } from '@txnet-backend/shared-core';
import { z } from 'zod';

/**
 * The wire shape of a set (TZ-1-d): an IANA zone this runtime can read. A
 * fixed offset (`+03:30`) is refused — DST is the IANA database's job
 * (ADR-0108 point 1). The service stores the canonical name.
 */
export const setTenantTimeZoneSchema = z
  .object({
    zone: z.string().refine(isIanaZone, 'must be an IANA time zone like Asia/Tehran'),
  })
  .strict();

export type SetTenantTimeZoneInput = z.infer<typeof setTenantTimeZoneSchema>;
