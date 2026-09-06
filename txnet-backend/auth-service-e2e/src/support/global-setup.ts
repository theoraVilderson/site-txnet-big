/**
 * Starts Postgres + Redis, builds the schema and seeds the rows the API
 * assumes always exist. Runs once, before any worker is forked.
 */
import { migrateAndSeed, startInfra, writeInfraFile } from './infra';

module.exports = async function () {
  const started = Date.now();
  console.log('\n[e2e] starting postgres + redis…');
  const { urls, stop } = await startInfra();

  console.log('[e2e] prisma db push + seed…');
  await migrateAndSeed(urls.databaseUrl);

  writeInfraFile(urls);
  (globalThis as any).__E2E_STOP_INFRA__ = stop;
  console.log(`[e2e] infrastructure ready in ${Date.now() - started}ms\n`);
};
