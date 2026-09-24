import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * F-027-bk: a panel group is where a variant's Grants are provisioned (§7.3).
 * The group names a strategy and how many healthy members a Grant needs; a
 * member names its role, and `drain` is how a panel leaves without cutting
 * anyone off (F-027-bm).
 *
 * The failures worth a spec are the tenant ones, because each is silent: a
 * platform group holding one reseller's dedicated panel serves every tenant's
 * users from it, and a variant naming another tenant's group sells that
 * tenant's servers. Postgres refuses both — a trigger per edge, since a CHECK
 * cannot see another row — and this spec holds that the refusals exist.
 *
 * Same method as `network-config-desired-state.spec.ts`: both sides are read
 * off disk, so a column dropped from one side is a red test, not a service
 * that boots against a table it cannot read.
 */

const DOMAINS = join(__dirname, '../../../../prisma/domains');
const MIGRATIONS = join(DOMAINS, 'migrations');

/** Every `migration.sql` in the history, concatenated. */
function migrationSql(): string {
  return readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      try {
        return readFileSync(join(MIGRATIONS, entry.name, 'migration.sql'), 'utf8');
      } catch {
        return '';
      }
    })
    .join('\n');
}

const network = readFileSync(join(DOMAINS, 'network.prisma'), 'utf8');
const catalog = readFileSync(join(DOMAINS, 'catalog.prisma'), 'utf8');
const sql = migrationSql();

/** The body of one `model` or `enum` block. */
function block(schema: string, kind: 'model' | 'enum', name: string): string {
  const found = new RegExp(`^${kind}\\s+${name}\\s*\\{([\\s\\S]*?)^\\}`, 'm').exec(schema);
  if (!found) throw new Error(`the schema declares no ${kind} ${name}`);
  return found[1];
}

/** An enum's values, in declaration order, without the attributes. */
function enumValues(name: string): string[] {
  return block(network, 'enum', name)
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').trim())
    .filter((line) => /^[a-z][a-z0-9_]*$/.test(line));
}

describe('network.PanelGroup: where a variant is provisioned', () => {
  const group = block(network, 'model', 'PanelGroup');
  const member = block(network, 'model', 'PanelGroupMember');

  it.each([
    ['tenantId', 'String\\?'],
    ['name', 'String'],
    ['strategy', 'PanelGroupStrategy'],
    ['minHealthyPanels', 'Int'],
    ['subscriptionTtlSeconds', 'Int'],
  ])('the group declares %s', (column, type) => {
    expect(group).toMatch(new RegExp(`^\\s*${column}\\s+${type}`, 'm'));
    expect(sql).toContain(`"${column}"`);
  });

  it.each([
    ['groupId', 'String'],
    ['panelId', 'String'],
    ['tenantId', 'String\\?'],
    ['priority', 'Int'],
    ['weight', 'Int'],
    ['role', 'PanelGroupMemberRole'],
  ])('the member declares %s', (column, type) => {
    expect(member).toMatch(new RegExp(`^\\s*${column}\\s+${type}`, 'm'));
  });

  it('names the three strategies the user chose, mirror first', () => {
    // User 2026-09-24: all three now. Only `mirror` is fulfilled (F-027-bl);
    // the other two are declared, not built.
    expect(enumValues('PanelGroupStrategy')).toEqual(['mirror', 'priority', 'weighted']);
    expect(group).toMatch(/^\s*strategy\s+PanelGroupStrategy\s+@default\(mirror\)/m);
  });

  it("keeps a member's role apart from the panel's HA role", () => {
    // `Panel.role` is active/passive for an HA pair. A member's role is what
    // fulfilment and draining read, and one enum for both would let a drain
    // be spelled as a panel's HA state.
    expect(enumValues('PanelGroupMemberRole')).toEqual(['primary', 'replica', 'drain']);
    expect(enumValues('PanelRole')).toEqual(['active', 'passive']);
  });

  it('holds a panel in a group once', () => {
    // Two rows for one panel would make fulfilment create two configs on it.
    expect(member).toMatch(/@@id\(\[groupId, panelId\]\)/);
  });

  it.each([
    'panel_group_min_healthy_positive',
    'panel_group_ttl_positive',
    'panel_group_member_priority_non_negative',
    'panel_group_member_weight_positive',
  ])('the database refuses a nonsense figure: %s', (constraint) => {
    expect(sql).toContain(constraint);
  });

  it("refuses a member panel that is another tenant's", () => {
    // A platform group holds platform panels only; a tenant's holds its own
    // and platform ones. The member carries its group's tenant for RLS.
    expect(sql).toMatch(/CREATE TRIGGER panel_group_member_fits\s+BEFORE INSERT OR UPDATE/);
    expect(sql).toMatch(/CREATE TRIGGER panel_group_tenant_is_fixed\s+BEFORE UPDATE OF "tenantId"/);
    expect(sql).toMatch(/CREATE TRIGGER panel_keeps_its_groups\s+AFTER UPDATE OF "tenantId"/);
  });

  it('is policied like the panels it groups', () => {
    for (const table of ['network.panel_group', 'network.panel_group_member']) {
      expect(sql).toContain(`'${table}'`);
    }
    expect(sql).toMatch(/panel_group[\s\S]*ENABLE ROW LEVEL SECURITY/);
  });
});

describe("catalog.ProductVariant.panelGroupId names a group, and one it may use", () => {
  const variant = block(catalog, 'model', 'ProductVariant');

  it('is a foreign key now that the group exists', () => {
    expect(variant).toMatch(/^\s*panelGroup\s+PanelGroup\?\s+@relation\(fields: \[panelGroupId\], references: \[id\], onDelete: Restrict\)/m);
    expect(sql).toContain('product_variant_panelGroupId_fkey');
  });

  it("refuses another tenant's group", () => {
    // The platform's groups serve anyone's variants; a tenant's only its own.
    expect(sql).toMatch(/CREATE TRIGGER product_variant_panel_group_fits\s+BEFORE INSERT OR UPDATE OF "tenantId", "panelGroupId"/);
  });
});
