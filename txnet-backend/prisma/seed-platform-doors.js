// The platform's own doors the seed registers (hosting R13). `TenantResolverService`
// matches `tenant_domain.domainValue` against exactly the hosts the platform is
// reached on. `panel.<domain>` is where the platform's own panel calls `/api/*`
// on its own origin (F-066-u, ADR-0060); `api.<domain>` is where bot-service and
// other callers reach the gate (dev-docker/docker-compose.main.yml) — an `api`
// door, so it answers like a panel but no link ("open your service", a payment's
// return) lands on it. `sub.<domain>` is the `subscription` door: a Grant's
// `/sub` link is built only on a `subscription` domain of its own tenant, and the
// domain route refuses every host under the platform's base, so nothing else can
// give the platform one. Resellers bring their own (a verified custom domain).
//
// The platform answers on two domains (ADR-0165 point 1, NIN-1-d2): DOMAIN_NAME,
// the Cloudflare door, and DOMESTIC_DOMAIN_NAME, the domestic door on Arvan,
// whose records `scripts/edge/arvan_zone.py` makes for the same three names.

/** The prefix and purpose of each door, the same on every platform domain. */
const DOORS = [
  { prefix: 'api', purpose: 'api' },
  { prefix: 'panel', purpose: 'panel' },
  { prefix: 'sub', purpose: 'subscription' },
];

/** `[{ host, purpose }]` for DOMAIN_NAME's doors, then DOMESTIC_DOMAIN_NAME's; an unset one adds none. */
function platformHosts(env) {
  const domains = [env.DOMAIN_NAME, env.DOMESTIC_DOMAIN_NAME].map((d) => (d || '').trim().toLowerCase());
  return [...new Set(domains.filter(Boolean))].flatMap((domain) =>
    DOORS.map(({ prefix, purpose }) => ({ host: `${prefix}.${domain}`, purpose })),
  );
}

module.exports = { platformHosts };
