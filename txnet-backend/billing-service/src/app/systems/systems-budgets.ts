import { RateLimitBucket, rateLimitBucketKey } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { identityOf } from '../request/identity.middleware';

/** A systems write that reaches a panel, the vault, money or many configs (F-027-ar). */
export const SYSTEMS_ADMIN_WRITE = {
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.SYSTEMS_ADMIN_WRITE, identityOf(req).userId),
  configKey: 'SYSTEMS_ADMIN_WRITE_RATE_LIMIT' as const,
  windowSec: 900,
};

/**
 * A systems write that only changes desired state in the database — a group,
 * a member, an inbound list, an audience, a cost, an acknowledge (LIVE-1-e).
 * Setting up one reseller's panels is dozens of these; `SYSTEMS_ADMIN_WRITE`
 * stays for the writes that reach a panel, the vault, money or many configs.
 */
export const SYSTEMS_ADMIN_SETTINGS = {
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.SYSTEMS_ADMIN_SETTINGS, identityOf(req).userId),
  configKey: 'SYSTEMS_ADMIN_SETTINGS_RATE_LIMIT' as const,
  windowSec: 900,
};

/** The systems page's reads (F-027-as): database only. */
export const SYSTEMS_ADMIN_READ = {
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.SYSTEMS_ADMIN_READ, identityOf(req).userId),
  configKey: 'SYSTEMS_ADMIN_READ_RATE_LIMIT' as const,
  windowSec: 900,
};
