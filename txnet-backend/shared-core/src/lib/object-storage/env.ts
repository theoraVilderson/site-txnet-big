import { z } from 'zod';

/** The drivers built: `local` (a mounted volume) and `s3` (any S3-compatible bucket, F-018-m2-a). */
export const OBJECT_STORAGE_DRIVERS = ['local', 's3'] as const;
/** `OBJECT_STORAGE_S3_PATH_STYLE`'s values: the bucket in the path, or in the host name. */
export const S3_PATH_STYLES = ['true', 'false'] as const;
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
  /** The `s3` driver's bucket; required, and checked at boot, only when the driver is `s3`. */
  OBJECT_STORAGE_S3_ENDPOINT: z.string().default(''),
  OBJECT_STORAGE_S3_REGION: z.string().default(''),
  OBJECT_STORAGE_S3_BUCKET: z.string().default(''),
  OBJECT_STORAGE_S3_ACCESS_KEY_ID: z.string().default(''),
  OBJECT_STORAGE_S3_SECRET_ACCESS_KEY: z.string().default(''),
  /** `false` only for a store that wants the bucket in the host name (AWS virtual-hosted style). */
  OBJECT_STORAGE_S3_PATH_STYLE: z.enum(S3_PATH_STYLES).default('true'),
  /** The HMAC key of private files' signed URLs (ADR-0113): the same value wherever one is minted and in tenant-service, which verifies it. */
  OBJECT_STORAGE_SIGNING_SECRET: z.string().min(32, 'OBJECT_STORAGE_SIGNING_SECRET must be at least 32 characters'),
};

/** The virus-scan variables of a service that takes uploads (rule 7). */
export const VIRUS_SCAN_ENV = {
  VIRUS_SCAN_DRIVER: z.preprocess((v) => (v === '' ? undefined : v), z.enum(VIRUS_SCAN_DRIVERS).default('none')),
  /** `host:port` of clamd, when the driver is `clamd`. */
  CLAMD_ADDR: z.string().default(''),
};
