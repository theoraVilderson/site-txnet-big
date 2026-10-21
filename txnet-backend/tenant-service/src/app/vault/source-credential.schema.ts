import { z } from 'zod';

/** An absolute http(s) address, as the source read dials it (`network` contract.source.md). */
const address = z
  .string()
  .max(2048)
  .refine((raw) => URL.canParse(raw) && ['http:', 'https:'].includes(new URL(raw).protocol), { message: 'must be an absolute http(s) address' });

/**
 * The wire shape of a run's source login (F-201-d). `.strict()`: the run, the
 * tenant and the expiry are the service's to set. `login` is in the family's
 * form, which `network-service` checks when it builds the driver.
 */
export const setSourceCredentialSchema = z
  .object({
    apiBaseUrl: address,
    clientBaseUrl: address.nullish().transform((v) => v ?? null),
    login: z.string().trim().min(1).max(4096),
  })
  .strict();

export type SetSourceCredentialInput = z.infer<typeof setSourceCredentialSchema>;
