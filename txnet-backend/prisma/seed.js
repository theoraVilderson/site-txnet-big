// Bootstraps the state the app assumes always exists but nothing ever
// creates: the `platform_owner` Tenant, the default RBAC roles, one owner
// User for that tenant, and the `tenant_domain` row for the host its API is
// served on. Idempotent — safe to run on every `db push` / `migrate dev` /
// `migrate reset`.
//
// The domain row is not a convenience. There is no fallback tenant (ADR-0025):
// a request whose Host matches no row is answered a neutral 404, so without
// this row a fresh install answers nothing at all.
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

// The host `auth-service` is actually reached on: Traefik routes
// `api.${DOMAIN_NAME}` to it (dev-docker/docker-compose.main.yml), and
// `TenantResolverService` matches `tenant_domain.domainValue` against exactly
// that. `subdomain` rather than `custom_domain` because the platform issued it
// — a custom domain would need verifying before it routed (tenant invariant 5).
function apiHost() {
  const domain = (process.env.DOMAIN_NAME || '').trim().toLowerCase();
  return domain ? `api.${domain}` : null;
}

// Idempotent, and never re-points an existing row: `domainValue` is unique, so
// a row already claimed by another tenant is that tenant's — a seed run must
// not move a host between tenants.
async function seedApiDomain(tenantId) {
  const host = apiHost();
  if (!host) {
    console.log('[seed] DOMAIN_NAME is unset — no tenant_domain row created.');
    console.log('[seed]   the API will answer 404 until one exists (ADR-0025).');
    return;
  }

  const existing = await prisma.tenantDomain.findUnique({
    where: { domainValue: host },
  });
  if (existing) {
    console.log(`[seed] tenant_domain '${host}' already exists, skipping.`);
    return;
  }

  await prisma.tenantDomain.create({
    data: {
      tenantId,
      domainType: 'subdomain',
      domainValue: host,
      // The platform owner's API host serves the panel routes; `subscription`
      // and `assets` doors serve none of them (F-066-q).
      purpose: 'panel',
      verificationStatus: 'verified',
      verifiedAt: new Date(),
    },
  });
  console.log(`[seed] created tenant_domain '${host}' -> platform_owner.`);
}

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
    // Not `return`: an install seeded before ADR-0025 has the tenant but no
    // domain row, and that install now answers 404 until it gets one.
    await seedApiDomain(existingTenant.id);
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

  await seedApiDomain(tenant.id);

  console.log('[seed] created platform_owner tenant + roles + owner user.');
  console.log('[seed]   owner username: platform_owner');
  console.log(`[seed]   owner password: ${password}`);
  console.log('[seed]   (shown once — save it now, only the argon2 hash is stored)');
  // bot-service has no host to resolve a tenant from and there is no fallback
  // (ADR-0025), so it states this id as X-Tenant-Id. Printed here because it
  // is generated here and needed in .env — F-066-h/F-066-i replace it with a
  // per-BotIntegration lookup.
  console.log(`[seed]   BOT_TENANT_ID=${tenant.id}`);
  console.log('[seed]   (put that in .env, or every bot flow answers 404)');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
