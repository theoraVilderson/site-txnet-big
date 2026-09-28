import { BackendI18nKeys } from '@txnet-backend/shared-core';
import { z } from 'zod';

import { grantDevicesSchema } from './grant-devices.schema';
import { grantFreezeSchema } from './grant-freeze.schema';
import { grantSpeedSchema } from './grant-speed.schema';
import { grantTrafficGiftSchema, grantTrafficSchema } from './grant-traffic.schema';

const E = BackendI18nKeys.errors.billing;

/** 1..50 Grants a call, as the config actions' 1..50 configs: one request, one bucket hit. */
const grantIds = z.array(z.string({ message: E.configActionInvalid }).uuid({ message: E.configActionInvalid }), { message: E.configActionInvalid }).min(1, { message: E.configActionInvalid }).max(50, { message: E.configActionInvalid });

/** Always asked: an act on many users' services is explained once, on every Grant's audit row. */
const reason = z.string({ message: E.configActionInvalid }).trim().min(1, { message: E.configActionInvalid }).max(500, { message: E.configActionInvalid });

/** The caller's own id for this one bulk act, minted once per confirm: a repeat answers the first call (F-311-u1). */
const requestId = z.string({ message: E.configActionInvalid }).uuid({ message: E.configActionInvalid });

const days = z.number({ message: E.configActionInvalid }).int({ message: E.configActionInvalid }).min(-3650, { message: E.configActionInvalid }).max(3650, { message: E.configActionInvalid }).refine((d) => d !== 0, { message: E.configActionInvalid });

/**
 * The body of `POST /api/billing/tenants/:tenantId/grants/bulk` (F-311-u):
 * the `requestId`, one `action`, 1..50 `grantIds` of the reseller's users, the `reason`, and
 * the action's own input — the single-Grant route's, with the same bounds.
 * `days` is relative only: a bulk move is "+3 days to everyone", never one
 * fixed date for Grants that end on different days.
 *
 * Not here: delete (asks a refund answer per Grant), renew and issue (a
 * `requestId` per Grant), rotate-token (every user's app would lose its link).
 */
export const grantBulkSchema = z.discriminatedUnion(
  'action',
  [
    z.object({ requestId, action: z.literal('freeze'), grantIds, until: grantFreezeSchema.shape.until, reason }).strict(),
    z.object({ requestId, action: z.literal('unfreeze'), grantIds, reason }).strict(),
    z.object({ requestId, action: z.literal('days'), grantIds, days, reason }).strict(),
    z.object({ requestId, action: z.literal('traffic'), grantIds, gb: grantTrafficSchema.shape.gb, reason }).strict(),
    z.object({ requestId, action: z.literal('traffic_reset'), grantIds, reason }).strict(),
    z.object({ requestId, action: z.literal('traffic_gift'), grantIds, gb: grantTrafficGiftSchema.shape.gb, reason }).strict(),
    z.object({ requestId, action: z.literal('speed'), grantIds, mbps: grantSpeedSchema.shape.mbps, reason }).strict(),
    z.object({ requestId, action: z.literal('devices'), grantIds, limit: grantDevicesSchema.shape.limit, reason }).strict(),
  ],
  { message: E.configActionInvalid },
);

export type GrantBulkBody = z.infer<typeof grantBulkSchema>;
export type GrantBulkAction = GrantBulkBody['action'];
