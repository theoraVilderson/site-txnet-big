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
function platformHosts() {
  const domain = (process.env.DOMAIN_NAME || '').trim().toLowerCase();
  return domain ? [`api.${domain}`, `panel.${domain}`] : [];
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

  for (const host of hosts) {
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
        // The platform owner's hosts serve the panel routes; `subscription`
        // and `assets` doors serve none of them (F-066-q).
        purpose: 'panel',
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
async function grantAllPermissionsToSuperAdmin() {
  const role = await prisma.role.findUniqueOrThrow({ where: { name: 'SuperAdmin' } });
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
// `tenant_billing.read` (F-019-j) likewise.
async function grantGatewayManageToAdmin() {
  const role = await prisma.role.findUniqueOrThrow({ where: { name: 'Admin' } });
  for (const key of ['gateway.manage', 'payment.confirm_manual', 'coupon.manage', 'catalog.manage', 'campaign.manage', 'tenant_billing.adjust', 'tenant_billing.topup', 'tenant_billing.read']) {
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
// quotes (`FX_QUOTE_CURRENCY_CODE`). Nothing else writes these rows, and the
// worker deliberately refuses to guess them (currency/open-questions.md), so a
// fresh install without them fails every rial quote with `RateUnavailable`.
// `update: {}` on purpose: an operator's later change to a row is theirs.
const CURRENCIES = [
  { code: 'USD', name: 'US Dollar', symbol: '$', decimalPlaces: 2, isBaseCurrency: true },
  { code: 'IRR', name: 'Iranian Rial', symbol: '﷼', decimalPlaces: 0, isBaseCurrency: false },
];

async function seedCurrencies() {
  for (const c of CURRENCIES) {
    await prisma.currency.upsert({ where: { code: c.code }, update: {}, create: c });
  }
}

// Six jobs run from a `bot_schedule` row seeded here; every other job waits
// for an operator (`automation/contract.worker.md` "A job is registered; it is
// not scheduled"). The worker creates its own `bot_worker` rows on boot; before
// that first boot there is nothing to schedule yet, and a re-run adds them.
// A job that already has any schedule is left exactly as the operator set it.
//
// - `fx_rate_refresh`: without it no rate is ever written
//   (currency/contract.fx-worker.md "How it is scheduled").
// - `deposit_pending_expiry` and `deposit_reconciliation` (decided 2026-09-14):
//   unscheduled, an abandoned top-up holds its coupon slots for ever and a
//   payment the bank took but whose callback never arrived is never credited —
//   the manual top-up legacy needed. Too costly to leave to someone remembering.
const SEEDED_SCHEDULES = [
  { key: 'fx_rate_refresh', scheduleType: 'cron_expression', cronExpression: '*/5 * * * *' },
  // Every tick (AUTOMATION_TICK_INTERVAL_MS, 60s): a clock, and it calls no gateway.
  { key: 'deposit_pending_expiry', scheduleType: 'always_on', cronExpression: null },
  // One gateway call per due payment, so a cron rather than every tick.
  { key: 'deposit_reconciliation', scheduleType: 'cron_expression', cronExpression: '*/5 * * * *' },
  // Due verify retries (F-092-ac): every tick, so the ladder's 30 s rung waits a
  // minute, not five. Only rows whose retry has come; most ticks ask nothing.
  { key: 'deposit_verify_retry', scheduleType: 'always_on', cronExpression: null },
  // The outbox relay (ADR-0021, decided 2026-09-14): unscheduled, every event a
  // payment writes — a late credit, a reversal — is never published, and the
  // payer is never told. Every tick, so a notice waits a minute at most.
  { key: 'outbox_relay', scheduleType: 'always_on', cronExpression: null },
  // Campaign fan-out (F-035-d, decided 2026-09-17): unscheduled, a started send
  // stays `sending` with no recipients and no error. Every tick; an idle one is
  // one query, and a run writes at most FAN_OUT_BUDGET rows.
  { key: 'notification_campaign_fan_out', scheduleType: 'always_on', cronExpression: null },
  // Campaign delivery (F-035-e), the fan-out's twin: unscheduled, recipients stay
  // `queued` forever. Every tick; an idle run is one claim query.
  { key: 'notification_campaign_delivery', scheduleType: 'always_on', cronExpression: null },
  // Reseller subscription renewal (F-019-c, decided 2026-09-17): unscheduled, no
  // period is ever charged and an unpaid reseller is never suspended. A credit
  // renews its payer at once through the outbox; this is the sweep behind it.
  { key: 'tenant_subscription_renewal', scheduleType: 'cron_expression', cronExpression: '*/5 * * * *' },
  // The nightly traffic rollup (F-027-o): unscheduled, `traffic_daily_aggregate`
  // is never written and the monthly raw partitions accumulate for ever — the
  // retention rule in `network/data-model.md` describes a thing nobody does.
  // 03:15 UTC: after midnight, so a whole day is closed, and off the hour that
  // every other cron in the estate wakes on.
  { key: 'network_traffic_rollup', scheduleType: 'cron_expression', cronExpression: '15 3 * * *' },
  // Custom-domain verification (F-018-i): unscheduled, no custom domain ever
  // becomes `verified` and a lost record never stops routing. An idle run is one query.
  { key: 'tenant_domain_verification', scheduleType: 'cron_expression', cronExpression: '*/5 * * * *' },
];

async function seedWorkerSchedules(adminId) {
  for (const { key, scheduleType, cronExpression } of SEEDED_SCHEDULES) {
    const worker = await prisma.botWorker.findUnique({ where: { key } });
    if (!worker) {
      console.log(`[seed] ${key} not registered yet — start worker-service once, then re-run the seed.`);
      continue;
    }
    const existing = await prisma.botSchedule.findFirst({ where: { botWorkerId: worker.id } });
    if (existing) continue;
    await prisma.botSchedule.create({
      data: { botWorkerId: worker.id, scheduleType, cronExpression, setByAdminId: adminId },
    });
    console.log(`[seed] scheduled ${key} (${cronExpression ?? scheduleType}).`);
  }
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
    await seedWorkerSchedules(existingTenant.ownerUserId);
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

  await seedPlatformDomains(tenant.id);
  await seedWorkerSchedules(ownerId);

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
