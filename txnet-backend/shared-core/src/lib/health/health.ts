import { writeFileSync } from 'node:fs';
import {
  Controller,
  DynamicModule,
  Get,
  Inject,
  Logger,
  Module,
  Optional,
  ServiceUnavailableException,
  Type,
} from '@nestjs/common';

/** Anything with Prisma's tagged `$queryRaw` — each service's own `PrismaService`. */
export interface HealthPool {
  $queryRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
}

/** The check `/health` runs; absent for a service with no database. */
type HealthProbe = () => Promise<unknown>;

const HEALTH_PROBE = Symbol('HEALTH_PROBE');

/** How often a consumer touches its heartbeat file; compose calls it stale at 60s (hosting H15). */
const HEARTBEAT_EVERY_MS = 15_000;

/** The file a service with no HTTP is checked by (hosting H15). */
export const HEARTBEAT_FILE = '/tmp/healthy';

/**
 * `GET /health` for compose and Swarm (hosting H15): 200 while the process is
 * up and `SELECT 1` on its pool succeeds, 503 otherwise — a service that
 * cannot reach Postgres is not one a restart should be withheld from.
 *
 * Each app keeps it outside its identity / tenant middleware and outside its
 * Traefik router: the check comes from inside the container, never the edge.
 */
@Controller('health')
export class HealthController {
  private readonly logger = new Logger('Health');

  constructor(@Optional() @Inject(HEALTH_PROBE) private readonly probe?: HealthProbe) {}

  @Get()
  async health(): Promise<{ ok: true }> {
    if (this.probe) {
      try {
        await this.probe();
      } catch (err) {
        this.logger.warn(`database unreachable: ${err instanceof Error ? err.message : String(err)}`);
        throw new ServiceUnavailableException();
      }
    }
    return { ok: true };
  }
}

/** The controller as a subclass carrying `marks`, so no other app's class is touched. */
function marked(marks: ClassDecorator[]): Type<HealthController> {
  if (marks.length === 0) return HealthController;
  class MarkedHealthController extends HealthController {}
  for (const mark of marks) mark(MarkedHealthController);
  return MarkedHealthController;
}

/** The one home of `/health` (C-27): an app imports one of the two forms below. */
@Module({})
export class HealthModule {
  /**
   * `/health` that is 503 when `SELECT 1` on `pool` fails. `pool` must be
   * injectable where the app imports this. `marks` are the app's own route
   * decorators its global guards read (auth-service: `TenantAgnostic()` —
   * the check comes with no tenant host), applied to this app's copy only.
   */
  static withPool(pool: Type<HealthPool>, ...marks: ClassDecorator[]): DynamicModule {
    return {
      module: HealthModule,
      controllers: [marked(marks)],
      providers: [{ provide: HEALTH_PROBE, inject: [pool], useFactory: (p: HealthPool) => () => p.$queryRaw`SELECT 1` }],
    };
  }

  /** `/health` for a service with no database (bot-service): up is healthy. */
  static processOnly(): DynamicModule {
    return { module: HealthModule, controllers: [HealthController] };
  }
}

/** The one event `startHeartbeat` needs from an amqplib channel. */
export interface ClosableChannel {
  once(event: 'close', listener: () => void): unknown;
}

/**
 * Touches `file` now and every 15s until `channel` closes (hosting H15). For
 * worker-service and metering-service, which serve no HTTP (ADR-0027): a
 * channel closed by a channel-level error leaves the process up and consuming
 * nothing, and only a file that stops being touched shows it. Returns the
 * stop for shutdown.
 */
export function startHeartbeat(channel: ClosableChannel, file: string = HEARTBEAT_FILE): () => void {
  const logger = new Logger('Heartbeat');
  const touch = () => {
    try {
      writeFileSync(file, new Date().toISOString());
    } catch (err) {
      // The check then fails on its own; this line says why.
      logger.warn(`could not write ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  touch();
  const timer = setInterval(touch, HEARTBEAT_EVERY_MS);
  timer.unref();
  const stop = () => clearInterval(timer);
  channel.once('close', stop);
  return stop;
}
