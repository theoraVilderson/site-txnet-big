import { Prisma } from '@prisma/client';

/** The include a person is loaded with whenever their keys are weighed: role, then its keys (`AccessReader.ofLoaded`). */
export const WITH_KEYS = {
  role: { include: { rolePermissions: { include: { permission: true } } } },
} as const satisfies Prisma.UserInclude;

/** A user as {@link WITH_KEYS} loads them — what a sign-in signs a token for. */
export type UserWithKeys = Prisma.UserGetPayload<{ include: typeof WITH_KEYS }>;
