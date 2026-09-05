// Bootstraps the state the app assumes always exists but nothing ever
// creates: the `platform_owner` Tenant, the default RBAC roles, and one
// owner User for that tenant. Idempotent — safe to run on every `db push`
// / `migrate dev` / `migrate reset`.
//
// Plain CommonJS on purpose: ts-node 10.9.1 fails to run a `.ts` entry file
// directly on Node 20 (`ERR_UNKNOWN_FILE_EXTENSION`, Node's own ESM/CJS
// detection runs before ts-node's require hook attaches) — not worth
// fighting for a one-off bootstrap script.
//
// Role names match two independent hardcoded references so both stay
// correct: `RegisterService.register` looks up `Role.name = 'user'`
// (docs/domains/identity/rules.md #5), and
// `ImpersonationService.isRoleHigher` ranks
// SuperAdmin > Admin > Support > User (docs/domains/identity/open-questions.md).
const { PrismaClient } = require('@prisma/client');
const argon2 = require('argon2');
const { randomBytes, randomUUID } = require('crypto');

const prisma = new PrismaClient();

const ROLE_NAMES = ['user', 'Support', 'Admin', 'SuperAdmin'];

function generatePassword() {
  // Satisfies strongPasswordSchema (upper, lower, digit, special, 8-72 chars)
  // without ever containing the owner's username/fullName.
  return `${randomBytes(15).toString('base64url')}Aa1!`;
}

async function main() {
  for (const name of ROLE_NAMES) {
    await prisma.role.upsert({
      where: { name },
      update: {},
      create: { name, isSystemRole: true },
    });
  }

  const existingTenant = await prisma.tenant.findUnique({
    where: { slug: 'platform_owner' },
  });
  if (existingTenant) {
    console.log('[seed] platform_owner tenant already exists, skipping.');
    return;
  }

  const superAdminRole = await prisma.role.findUniqueOrThrow({
    where: { name: 'SuperAdmin' },
  });

  const ownerId = randomUUID();
  const password = generatePassword();
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });

  const tenant = await prisma.tenant.create({
    data: {
      tenantType: 'platform_owner',
      ownerUserId: ownerId,
      slug: 'platform_owner',
      status: 'active',
      // ASSUMED(2026-09-04): the platform's own tenant doesn't bill itself;
      // the column is required with no "n/a" value, so this is arbitrary.
      // See docs/domains/tenant/open-questions.md.
      billingModel: 'subscription_monthly',
    },
  });

  await prisma.user.create({
    data: {
      id: ownerId,
      tenantId: tenant.id,
      fullName: 'Platform Owner',
      username: 'platform_owner',
      passwordHash,
      roleId: superAdminRole.id,
      status: 'active',
      phoneVerifiedAt: new Date(),
    },
  });

  console.log('[seed] created platform_owner tenant + roles + owner user.');
  console.log('[seed]   owner username: platform_owner');
  console.log(`[seed]   owner password: ${password}`);
  console.log('[seed]   (shown once — save it now, only the argon2 hash is stored)');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
