import { z } from 'zod';

/** The drivers built: `local` only — an S3-compatible one arrives behind the same port. */
export const OBJECT_STORAGE_DRIVERS = ['local'] as const;
/** `clamd` in production; `none` calls every file clean (ADR-0113 point 4). */
export const VIRUS_SCAN_DRIVERS = ['clamd', 'none'] as const;

/**
 * The object-storage variables, declared once and spread into every envSchema
 * of a service that stores files (C-26, C-27; `platform/object-storage`
 * "Configuration"). A service's `ConfigService` serves only the keys its own
 * schema kept, so each spreads what it uses.
 */
export const OBJECT_STORAGE_ENV = {
  OBJECT_STORAGE_DRIVER: z.enum(OBJECT_STORAGE_DRIVERS).default('local'),
  /** The volume — one node, or one every replica shares (rule 5). */
  OBJECT_STORAGE_LOCAL_ROOT: z.string().min(1).default('/data/objects'),
  /** The HMAC key of private files' signed URLs (ADR-0113): the same value wherever one is minted and in tenant-service, which verifies it. */
  OBJECT_STORAGE_SIGNING_SECRET: z.string().min(32, 'OBJECT_STORAGE_SIGNING_SECRET must be at least 32 characters'),
};

/** The virus-scan variables of a service that takes uploads (rule 7). */
export const VIRUS_SCAN_ENV = {
  VIRUS_SCAN_DRIVER: z.preprocess((v) => (v === '' ? undefined : v), z.enum(VIRUS_SCAN_DRIVERS).default('none')),
  /** `host:port` of clamd, when the driver is `clamd`. */
  CLAMD_ADDR: z.string().default(''),
};
