import { Controller, Get } from '@nestjs/common';
import { ConnectionRegistry } from './realtime/connection.registry';

/**
 * The only HTTP route this service serves.
 *
 * It exists because Traefik and compose both need something to ask, and
 * because `connections` is the number an operator wants first when a realtime
 * problem is reported — a replica holding zero sockets while another holds
 * thousands is a routing problem, and no other signal shows it.
 *
 * Deliberately unauthenticated and deliberately on the private network only:
 * the Traefik router publishes the realtime path, not this one.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly registry: ConnectionRegistry) {}

  @Get()
  health() {
    return { ok: true, connections: this.registry.size };
  }
}
