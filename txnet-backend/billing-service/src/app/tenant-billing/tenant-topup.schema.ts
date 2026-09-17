import { z } from 'zod';

import { depositStartSchema } from '../payment/deposit/deposit.schema';

/**
 * The wire shape of a reseller's billing top-up (F-019-b). The deposit start's
 * own gateway and amount rules, and nothing else: the source is always
 * `platform` and a billing top-up takes no coupon. `.strict()` refuses the rest.
 */
export const tenantTopupSchema = depositStartSchema.pick({ gatewayId: true, amount: true }).strict();

export type TenantTopupBody = z.infer<typeof tenantTopupSchema>;
