import { ConnectionRegistry, type Connection } from './connection.registry';
import { RealtimeGateway } from './realtime.gateway';

/**
 * The invariant OPS-1-t turns on (ADR-0126 point 12, hosting H20): **a
 * restart closes every socket with 1012 ("service restart").** That is the
 * code the panel reads as "spread your reconnect over 0–10s"; any other code
 * sends every open panel back at the same instant, onto a gateway that is
 * still starting.
 */

const CONFIG: Record<string, string | number> = {
  REALTIME_PATH: '/ws',
  REALTIME_HEARTBEAT_MS: 30000,
  REALTIME_SESSION_RECHECK_MS: 60000,
  REALTIME_MAX_SUBSCRIPTIONS: 50,
  REALTIME_MAX_CONNECTIONS_PER_USER: 5,
  REALTIME_MAX_CONNECTIONS_PER_IP: 20,
  REALTIME_MAX_FRAME_BYTES: 65536,
};

function connection(id: string, closes: [number, string][]): Connection {
  return {
    id,
    identity: { userId: `u-${id}`, tenantId: 't-1', sessionId: `s-${id}`, permissions: [] },
    address: '203.0.113.1',
    socket: { readyState: 1, close: (code: number, reason: string) => void closes.push([code, reason]) } as never,
    subscriptions: new Set<string>(),
    alive: true,
  };
}

describe('RealtimeGateway.onApplicationShutdown', () => {
  it('closes every open socket with 1012, the restart code the panel spreads its reconnect on', () => {
    const registry = new ConnectionRegistry();
    const config = { get: (key: string) => CONFIG[key] };
    const gateway = new RealtimeGateway(registry, {} as never, {} as never, {} as never, config as never);
    const closes: [number, string][] = [];
    registry.add(connection('a', closes));
    registry.add(connection('b', closes));

    gateway.onApplicationShutdown();

    expect(closes.map(([code]) => code)).toEqual([1012, 1012]);
  });
});
