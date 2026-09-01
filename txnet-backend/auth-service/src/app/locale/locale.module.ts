import { Module } from '@nestjs/common';
import { LocaleService } from './locale.service';

/**
 * locale-service (Go, gRPC) is the source of truth and does its own file
 * watching, so there is no in-process watcher any more — LocaleService keeps a
 * live cache via the Watch stream.
 */
@Module({
  providers: [LocaleService],
  exports: [LocaleService],
})
export class LocaleModule {}
