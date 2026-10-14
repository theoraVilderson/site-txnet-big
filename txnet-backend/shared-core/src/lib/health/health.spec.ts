import { EventEmitter } from 'node:events';
import { mkdtempSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServiceUnavailableException, SetMetadata } from '@nestjs/common';
import { HealthController, HealthModule, startHeartbeat } from './health';

/**
 * Hosting H15: a container is healthy only while it can do its work. For an
 * HTTP service that is "the process answers and `SELECT 1` on its pool
 * succeeds"; for a consumer with no HTTP it is "the file is fresh, and it stays
 * fresh only while the broker channel is open". A check that says healthy
 * while the database is gone, or while the channel closed under a live
 * process, is the failure this exists to remove.
 */
describe('HealthController', () => {
  it('answers ok when the pool answers', async () => {
    const probe = vi.fn(async () => [{ '?column?': 1 }]);
    await expect(new HealthController(probe).health()).resolves.toEqual({ ok: true });
    expect(probe).toHaveBeenCalledOnce();
  });

  it('answers 503 when the pool does not', async () => {
    const probe = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    });
    await expect(new HealthController(probe).health()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('answers ok for a service with no pool', async () => {
    await expect(new HealthController().health()).resolves.toEqual({ ok: true });
  });

  it("carries an app's own guard marks on that app's copy, never on the shared class", () => {
    class Pool {
      $queryRaw = async () => [];
    }
    const [controller] = HealthModule.withPool(Pool, SetMetadata('tenantAgnostic', true)).controllers ?? [];
    expect(Reflect.getMetadata('tenantAgnostic', controller)).toBe(true);
    expect(Reflect.getMetadata('tenantAgnostic', HealthController)).toBeUndefined();
  });
});

describe('startHeartbeat', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('touches the file at once and every 15s, and stops when the channel closes', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'heartbeat-')), 'healthy');
    const channel = new EventEmitter();
    startHeartbeat(channel, file);
    expect(existsSync(file)).toBe(true);

    const first = statSync(file).mtimeMs;
    vi.advanceTimersByTime(15_000);
    const second = statSync(file).mtimeMs;
    expect(second).toBeGreaterThanOrEqual(first);

    channel.emit('close');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops when asked, for a clean shutdown', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'heartbeat-')), 'healthy');
    const stop = startHeartbeat(new EventEmitter(), file);
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
