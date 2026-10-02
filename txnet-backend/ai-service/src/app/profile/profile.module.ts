import { Module } from '@nestjs/common';

import { PolicyModule } from '../policy/policy.module';
import { ProfileBuilder } from './profile-builder.service';
import { ProfileInternalController } from './profile-internal.controller';
import { ProfileReader } from './profile-reader';

@Module({
  imports: [PolicyModule],
  controllers: [ProfileInternalController],
  providers: [ProfileReader, ProfileBuilder],
})
export class ProfileModule {}
