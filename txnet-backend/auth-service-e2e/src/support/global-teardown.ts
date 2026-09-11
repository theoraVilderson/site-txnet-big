import { rmSync } from 'node:fs';
import { INFRA_FILE } from './infra';

export async function teardown() {
  const stop = (globalThis as any).__E2E_STOP_INFRA__ as
    | (() => Promise<void>)
    | undefined;
  if (stop) await stop();
  rmSync(INFRA_FILE, { force: true });
  console.log('\n[e2e] infrastructure stopped\n');
}
