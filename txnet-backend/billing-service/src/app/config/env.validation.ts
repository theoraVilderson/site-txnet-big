import { z } from 'zod';

/**
 * `billing-service`'s environment, validated at boot (F-089, ADR-0036).
 *
 * **Why a scaffold gets a schema before it gets features.** This was the one Nx
 * application on the platform with no env validation at all: `main.ts` read
 * `process.env.PORT` raw and logged a hardcoded `http://localhost:<port>`. The
 * other four each have a zod `envSchema` behind `ConfigService`, so this was
 * also the only deployable that could start with a typo'd variable and report
 * itself healthy.
 *
 * Doing it now is cheap and doing it later is not. F-039 fills this service in;
 * at that point there are call sites reading `process.env` directly and the
 * change becomes a migration instead of a file. The schema is deliberately
 * small — what exists today plus the shape the next variable slots into — and
 * not a guess at what billing will need. Adding a field nobody asked for is how
 * a config schema becomes a list of things that are never set.
 *
 * Modelled on `gateway-service/src/app/config/env.validation.ts`.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  /**
   * The prefix every route sits under. A constant in `main.ts` until now, and
   * configuration here for the same reason the port is: it is part of the
   * address Traefik routes to, and an address the image cannot be told about
   * is one that needs a rebuild to change.
   */
  GLOBAL_PREFIX: z.string().min(1).default('api'),

  /**
   * The host this service reports itself reachable at, for the boot log only.
   *
   * `main.ts` logged `http://localhost:<port>` unconditionally, which is wrong
   * in every environment where it matters: inside a container `localhost` is
   * the container, and the line an operator reads after a deploy pointed at an
   * address nothing outside could reach.
   */
  PUBLIC_HOST: z.string().min(1).default('localhost'),
});

export type EnvConfig = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): EnvConfig {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    console.error(
      '❌ Invalid environment variables:',
      parsed.error.flatten().fieldErrors,
    );
    throw new Error('Environment validation failed — see log above');
  }
  return parsed.data;
}

/**
 * `skipProcessEnv` for the reason the other three services document: compose
 * passes every optional variable as `VAR=${VAR:-}`, so an unset option arrives
 * as the empty string, and `ConfigService.get` reads the validated env first
 * and `process.env` second — without this it would prefer that raw `''` to the
 * schema's default.
 */
export const envConfigOptions = {
  isGlobal: true,
  validate: validateEnv,
  skipProcessEnv: true,
} as const;
