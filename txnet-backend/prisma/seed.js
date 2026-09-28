// Bootstraps the state the app assumes always exists but nothing ever
// creates: the `platform_owner` Tenant, the default RBAC roles, one owner
// User for that tenant, and the `tenant_domain` row for the host its API is
// served on, the two ADR-0019 currencies and the schedules of the three jobs that must never wait for an operator. Idempotent — safe to run on every `db push` / `migrate dev` /
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

// The hosts `auth-service` is actually reached on, and `TenantResolverService`
// matches `tenant_domain.domainValue` against exactly those. `panel.<domain>`
// is where the platform's own panel calls `/api/*` on its own origin (F-066-u,
// ADR-0060); `api.<domain>` is still where bot-service and other callers reach
// the gate (dev-docker/docker-compose.main.yml). `subdomain` rather than
// `custom_domain` because the platform issued them — a custom domain would need
// verifying before it routed (tenant invariant 5).
// `sub.<domain>` is the platform's `subscription` door: a Grant's `/sub` link
// is built only on a `subscription` domain of its own tenant, and the domain
// route refuses every host under the platform's base, so nothing else can
// give the platform one. Resellers bring their own (a verified custom domain).
function platformHosts() {
  const domain = (process.env.DOMAIN_NAME || '').trim().toLowerCase();
  return domain
    ? [
        { host: `api.${domain}`, purpose: 'panel' },
        { host: `panel.${domain}`, purpose: 'panel' },
        { host: `sub.${domain}`, purpose: 'subscription' },
      ]
    : [];
}

// Idempotent, and never re-points an existing row: `domainValue` is unique, so
// a row already claimed by another tenant is that tenant's — a seed run must
// not move a host between tenants.
async function seedPlatformDomains(tenantId) {
  const hosts = platformHosts();
  if (hosts.length === 0) {
    console.log('[seed] DOMAIN_NAME is unset — no tenant_domain row created.');
    console.log('[seed]   the API will answer 404 until one exists (ADR-0025).');
    return;
  }

  for (const { host, purpose } of hosts) {
    const existing = await prisma.tenantDomain.findUnique({
      where: { domainValue: host },
    });
    if (existing) {
      console.log(`[seed] tenant_domain '${host}' already exists, skipping.`);
      continue;
    }

    await prisma.tenantDomain.create({
      data: {
        tenantId,
        domainType: 'subdomain',
        domainValue: host,
        // `panel` hosts serve the panel routes; the `subscription` door
        // serves none of them, only `/sub` (F-066-q).
        purpose,
        verificationStatus: 'verified',
        verifiedAt: new Date(),
      },
    });
    console.log(`[seed] created tenant_domain '${host}' -> platform_owner.`);
  }
}

// F-101-d (ADR-0043 as amended): SuperAdmin holds the one permission `*`, which
// every check reads as "any key". Migration 20260913000100 makes the same grant
// on a database whose role already existed; on a fresh one the role is created
// above, after migrations ran, so the grant has to happen here too.
function systemRole(name) {
  return prisma.role.findFirst({ where: { name, tenantId: null } });
}

async function systemRoleOrThrow(name) {
  const role = await systemRole(name);
  if (!role) throw new Error(`system role ${name} is missing`);
  return role;
}

async function grantAllPermissionsToSuperAdmin() {
  const role = await systemRoleOrThrow('SuperAdmin');
  const all = await prisma.permission.upsert({
    where: { key: '*' },
    update: {},
    create: { key: '*' },
  });
  await prisma.rolePermission.upsert({
    where: { roleId_permissionId: { roleId: role.id, permissionId: all.id } },
    update: {},
    create: { roleId: role.id, permissionId: all.id },
  });
}

// F-102-c (D-31): a tenant's Admin manages its own payment gateways. The same
// grant as migration 20260913000300, for a fresh database whose roles are
// created here after migrations ran.
// F-092-z (ADR-0044 decision 6): the same Admin confirms a verifying payment
// on those gateways by hand — migration 20260914000300's grant, for a fresh
// database.
// F-502-a (D-33): the same Admin manages its own tenant's coupons — migration
// 20260914000900's grant, for a fresh database. `campaign.manage` (F-035-c) and
// `tenant_billing.adjust` (F-019-a), `tenant_billing.topup` (F-019-b) and
// `tenant_billing.read` (F-019-j) likewise, `user_group.manage` (F-114-j) and `currency.pin` (F-0608-a).
async function grantGatewayManageToAdmin() {
  const role = await systemRoleOrThrow('Admin');
  for (const key of ['gateway.manage', 'payment.confirm_manual', 'coupon.manage', 'catalog.manage', 'campaign.manage', 'tenant_billing.adjust', 'tenant_billing.topup', 'tenant_billing.read', 'user_group.manage', 'currency.pin']) {
    const permission = await prisma.permission.upsert({ where: { key }, update: {}, create: { key } });
    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } },
      update: {},
      create: { roleId: role.id, permissionId: permission.id },
    });
  }
}

// ADR-0019: USD is the one base currency, two decimal places, and every money
// column is in it; IRR is what a rial gateway is paid in and what the FX worker
// quotes first. The rest are what F-116-i/i2 rate (ADR-0098 part 8), at their
// ISO 4217 decimals — never above two, the money columns' scale (part 6). Nothing else writes these rows, and the
// worker deliberately refuses to guess them (currency/open-questions.md), so a
// fresh install without them fails every rial quote with `RateUnavailable`.
// `update: {}` on purpose: an operator's later change to a row is theirs.
const CURRENCIES = [
  { code: 'USD', name: 'US Dollar', symbol: '$', decimalPlaces: 2, isBaseCurrency: true },
  { code: 'IRR', name: 'Iranian Rial', symbol: '﷼', decimalPlaces: 0, isBaseCurrency: false },
  // Ten rials, never a rate of its own: readFxRate answers IRR / 10 (F-116-m).
  { code: 'IRT', name: 'Iranian Toman', symbol: 'تومان', decimalPlaces: 0, isBaseCurrency: false },
  { code: 'EUR', name: 'Euro', symbol: '€', decimalPlaces: 2, isBaseCurrency: false },
  { code: 'TRY', name: 'Turkish Lira', symbol: '₺', decimalPlaces: 2, isBaseCurrency: false },
  { code: 'GBP', name: 'British Pound', symbol: '£', decimalPlaces: 2, isBaseCurrency: false },
  { code: 'AED', name: 'UAE Dirham', symbol: 'AED', decimalPlaces: 2, isBaseCurrency: false },
  { code: 'CNY', name: 'Chinese Yuan', symbol: 'CN¥', decimalPlaces: 2, isBaseCurrency: false },
  { code: 'JPY', name: 'Japanese Yen', symbol: '¥', decimalPlaces: 0, isBaseCurrency: false },
  { code: 'CAD', name: 'Canadian Dollar', symbol: 'CA$', decimalPlaces: 2, isBaseCurrency: false },
  { code: 'AUD', name: 'Australian Dollar', symbol: 'A$', decimalPlaces: 2, isBaseCurrency: false },
  { code: 'CHF', name: 'Swiss Franc', symbol: 'CHF', decimalPlaces: 2, isBaseCurrency: false },
  { code: 'SAR', name: 'Saudi Riyal', symbol: 'SAR', decimalPlaces: 2, isBaseCurrency: false },
  { code: 'QAR', name: 'Qatari Riyal', symbol: 'QAR', decimalPlaces: 2, isBaseCurrency: false },
  { code: 'RUB', name: 'Russian Ruble', symbol: '₽', decimalPlaces: 2, isBaseCurrency: false },
  { code: 'AZN', name: 'Azerbaijani Manat', symbol: '₼', decimalPlaces: 2, isBaseCurrency: false },
  { code: 'KRW', name: 'South Korean Won', symbol: '₩', decimalPlaces: 0, isBaseCurrency: false },
  { code: 'SEK', name: 'Swedish Krona', symbol: 'SEK', decimalPlaces: 2, isBaseCurrency: false },
  { code: 'NOK', name: 'Norwegian Krone', symbol: 'NOK', decimalPlaces: 2, isBaseCurrency: false },
  { code: 'DKK', name: 'Danish Krone', symbol: 'DKK', decimalPlaces: 2, isBaseCurrency: false },
  { code: 'INR', name: 'Indian Rupee', symbol: '₹', decimalPlaces: 2, isBaseCurrency: false },
  { code: 'MYR', name: 'Malaysian Ringgit', symbol: 'RM', decimalPlaces: 2, isBaseCurrency: false },
  { code: 'THB', name: 'Thai Baht', symbol: '฿', decimalPlaces: 2, isBaseCurrency: false },
  { code: 'HKD', name: 'Hong Kong Dollar', symbol: 'HK$', decimalPlaces: 2, isBaseCurrency: false },
  { code: 'SGD', name: 'Singapore Dollar', symbol: 'S$', decimalPlaces: 2, isBaseCurrency: false },
];

async function seedCurrencies() {
  for (const c of CURRENCIES) {
    await prisma.currency.upsert({ where: { code: c.code }, update: {}, create: c });
  }
}

// Job schedules are not seeded: a job that has to run declares its
// `defaultSchedule` and worker-service writes it on boot (F-114-a).

function generatePassword() {
  // Satisfies strongPasswordSchema (upper, lower, digit, special, 8-72 chars)
  // without ever containing the owner's username/fullName.
  return `${randomBytes(15).toString('base64url')}Aa1!`;
}

async function main() {
  // A system role has no tenant; `(tenantId, name)` cannot be upserted on a
  // null, so it is found by the partial index `role_system_name_key` instead.
  for (const name of ROLE_NAMES) {
    if (!(await systemRole(name))) await prisma.role.create({ data: { name, isSystemRole: true } });
  }
  await grantAllPermissionsToSuperAdmin();
  await grantGatewayManageToAdmin();
  await seedCurrencies();

  const existingTenant = await prisma.tenant.findUnique({
    where: { slug: 'platform_owner' },
  });
  if (existingTenant) {
    console.log('[seed] platform_owner tenant already exists, skipping.');
    // Not `return`: an install seeded before ADR-0025 has the tenant but no
    // domain row, and that install now answers 404 until it gets one.
    await seedPlatformDomains(existingTenant.id);
    return;
  }

  const superAdminRole = await systemRoleOrThrow('SuperAdmin');

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

  await seedPlatformDomains(tenant.id);

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
