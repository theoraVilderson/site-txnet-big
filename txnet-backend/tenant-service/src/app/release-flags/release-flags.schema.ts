import { ReleaseFlagStage } from '@prisma/client';
import { z } from 'zod';

/** `PUT tenants/release-flags/:key` (OPS-1-ag): how far the flag has rolled out. */
export const setReleaseFlagStageSchema = z.object({ stage: z.nativeEnum(ReleaseFlagStage) }).strict();
export type SetReleaseFlagStageInput = z.infer<typeof setReleaseFlagStageSchema>;

/** `PUT tenants/release-flags/:key/tenants/:tenantId`: one reseller's own answer over the stage. */
export const setReleaseFlagExceptionSchema = z.object({ isOn: z.boolean() }).strict();
export type SetReleaseFlagExceptionInput = z.infer<typeof setReleaseFlagExceptionSchema>;
