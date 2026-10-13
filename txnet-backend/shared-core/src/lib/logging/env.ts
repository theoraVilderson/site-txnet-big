import { z } from 'zod';

/** H12: `json` for Loki, `pretty` for a person reading `docker logs` in dev. */
export const LOG_FORMATS = ['json', 'pretty'] as const;
export type LogFormat = (typeof LOG_FORMATS)[number];

/**
 * The logging variables, validated once here rather than restated in every
 * service's `envSchema` (C-26, C-27) — a service's `ConfigService` serves only
 * the keys its own schema kept. `APP_NAME` is the image's own `ENV`
 * (`txnet-backend/Dockerfile`), so a container never lacks it; a boot without
 * it is refused, as an app's own schema would refuse it.
 */
const loggingEnvSchema = z.object({
  NODE_ENV: z.string().default('development'),
  APP_NAME: z.string().min(1),
  LOG_FORMAT: z.preprocess((v) => (v === '' ? undefined : v), z.enum(LOG_FORMATS).optional()),
});

/** The service name and line format H12 asks for, from `env` (the process's by default). */
export function loggingEnv(env: Record<string, string | undefined> = process.env): { service: string; format: LogFormat } {
  const parsed = loggingEnvSchema.parse(env);
  // Unset means `json` in production and `pretty` everywhere else, so dev reads as it did.
  return { service: parsed.APP_NAME, format: parsed.LOG_FORMAT ?? (parsed.NODE_ENV === 'production' ? 'json' : 'pretty') };
}
