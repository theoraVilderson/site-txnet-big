import { CounterSemantics, DriverType, PanelRole, PanelTransport } from '@prisma/client';
import { z } from 'zod';

/**
 * The wire shape of registering a panel (F-027-ar).
 *
 * **`.strict()`.** An unknown key is refused, not dropped: `reviewState`,
 * `capabilities`, `tenantId` and `ownershipType` are exactly what a client
 * might send expecting it to land, and each is someone else's to write — the
 * connection test's, or the owner rule's.
 *
 * `credentials` is the panel's login, opaque (a password, a token, a JSON
 * pair — the driver family decides, F-027-ae), bounded and relayed once to the
 * vault. A pull panel needs the address we poll it at; the database refuses
 * one without it too (`panel_pull_has_base_url`), but a 400 naming the field
 * beats a 500 naming a constraint.
 */
export const registerPanelSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    ipAddress: z.union([z.string().ip({ version: 'v4' }), z.string().ip({ version: 'v6' })]),
    apiBaseUrl: z.string().url().max(500).nullable().optional(),
    driverType: z.nativeEnum(DriverType),
    counterSemantics: z.nativeEnum(CounterSemantics),
    transport: z.nativeEnum(PanelTransport),
    role: z.nativeEnum(PanelRole),
    region: z.string().trim().min(1).max(50),
    maxRequestsPerMinute: z.number().int().positive().max(6000).optional(),
    credentials: z.string().min(1).max(4096),
  })
  .strict()
  .refine((body) => body.transport !== PanelTransport.pull || !!body.apiBaseUrl, {
    path: ['apiBaseUrl'],
    message: 'apiBaseUrl is required for a pull panel',
  });

export type RegisterPanelBody = z.infer<typeof registerPanelSchema>;
