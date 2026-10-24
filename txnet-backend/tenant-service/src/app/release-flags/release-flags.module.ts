import { Module } from '@nestjs/common';

import { ReleaseFlagsController, ReleaseFlagsMineController } from './release-flags.controller';
import { ReleaseFlagsService, releaseFlagKeysProvider } from './release-flags.service';

/**
 * Release flags (OPS-1-ag, ADR-0164 point 4): the platform switches a risky
 * feature per tenant without a deploy. `PrismaModule` and `RedisModule` are
 * `@Global`, so neither is imported here.
 *
 * The mine controller is listed first: `GET tenants/release-flags/mine` must
 * never reach the platform guard of the table beside it.
 */
@Module({
  controllers: [ReleaseFlagsMineController, ReleaseFlagsController],
  providers: [ReleaseFlagsService, releaseFlagKeysProvider],
})
export class ReleaseFlagsModule {}
