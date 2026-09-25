import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * F-026-q: categories nest, and a product sits in several (user, 2026-09-25).
 *
 * Two shapes change. A category gains a parent — a plain self FK, RESTRICT,
 * so a parent with children is never deleted out from under them, and the
 * same tenant rule a product already obeys (a child under its own tenant's
 * category or the platform's). A product loses its one `categoryId` to a join
 * table: the user chose the table alone, no "main category" beside it, so no
 * reader ever has to union two places to learn where a product is filed.
 *
 * The depth is not capped here on purpose: the cap is one constant in code
 * (F-026-r), raised without a migration. A cycle is refused in the database,
 * because two concurrent re-parents can each pass a check made in code.
 *
 * Same method as `catalog-metered-rate.spec.ts`: both sides read off disk.
 */

const DOMAINS = join(__dirname, '../../../../prisma/domains');
const MIGRATIONS = join(DOMAINS, 'migrations');

function migrationSql(): string {
  return readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => {
      try {
        return readFileSync(join(MIGRATIONS, entry.name, 'migration.sql'), 'utf8');
      } catch {
        return '';
      }
    })
    .join('\n');
}

const catalog = readFileSync(join(DOMAINS, 'catalog.prisma'), 'utf8');
const sql = migrationSql();

function model(schema: string, name: string): string {
  const found = new RegExp(`^model\\s+${name}\\s*\\{([\\s\\S]*?)^\\}`, 'm').exec(schema);
  if (!found) throw new Error(`no model ${name}`);
  return found[1];
}

describe('catalog.ProductCategory — a category may sit under another', () => {
  const category = model(catalog, 'ProductCategory');

  it('declares a nullable parentId and both ends of the relation', () => {
    expect(category).toMatch(/^\s*parentId\s+String\?\s+@db\.Uuid/m);
    expect(category).toMatch(/^\s*parent\s+ProductCategory\?\s+@relation\("CategoryTree"/m);
    expect(category).toMatch(/^\s*children\s+ProductCategory\[\]\s+@relation\("CategoryTree"\)/m);
  });

  it('keeps a parent with children: the FK is RESTRICT', () => {
    expect(sql).toMatch(
      /"product_category_parentId_fkey" FOREIGN KEY \("parentId"\) REFERENCES "catalog"\."product_category"\("id"\) ON DELETE RESTRICT/,
    );
  });

  it('files a child under its own tenant or the platform, as a product is filed', () => {
    expect(sql).toMatch(/CREATE TRIGGER product_category_parent_same_tenant[\s\S]*?catalog\.category_parent_ok\(\)/);
  });

  it('refuses a cycle in the database, not only in code', () => {
    expect(sql).toContain('category_cycle');
  });
});

describe('catalog.ProductCategoryLink — a product sits in one or more categories', () => {
  const product = model(catalog, 'Product');
  const link = model(catalog, 'ProductCategoryLink');

  it('takes categoryId off the product: the link is the only place', () => {
    expect(product).not.toMatch(/^\s*categoryId\s/m);
    expect(product).toMatch(/^\s*categories\s+ProductCategoryLink\[\]/m);
    expect(sql).toMatch(/ALTER TABLE "catalog"\."product" DROP COLUMN "categoryId"/);
  });

  it.each(['productId', 'categoryId', 'tenantId', 'position'])('the link declares %s', (column) => {
    expect(link).toMatch(new RegExp(`^\\s*${column}\\s`, 'm'));
  });

  it('files a product in a category once, and orders them per product', () => {
    expect(link).toMatch(/@@id\(\[productId, categoryId\]\)/);
    expect(link).toMatch(/@@index\(\[categoryId\]\)/);
  });

  it('carries every existing product over before the column goes', () => {
    const backfill = sql.indexOf('INSERT INTO "catalog"."product_category_link"');
    const drop = sql.indexOf('ALTER TABLE "catalog"."product" DROP COLUMN "categoryId"');
    expect(backfill).toBeGreaterThan(-1);
    expect(drop).toBeGreaterThan(backfill);
  });

  it('keeps a category any product sits in: the category FK is RESTRICT, the product one CASCADE', () => {
    expect(sql).toMatch(/"product_category_link_categoryId_fkey"[^;]*ON DELETE RESTRICT/);
    expect(sql).toMatch(/"product_category_link_productId_fkey"[^;]*ON DELETE CASCADE/);
  });

  it('carries its product tenant and a category the product may sit in', () => {
    expect(sql).toMatch(/CREATE TRIGGER product_category_link_same_tenant[\s\S]*?catalog\.category_link_ok\(\)/);
  });

  it('is read by a tenant the way the rest of the catalog is', () => {
    expect(sql).toMatch(/'catalog\.product_category_link'/);
  });
});
