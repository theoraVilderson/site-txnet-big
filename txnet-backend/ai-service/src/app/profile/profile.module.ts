import { Module } from '@nestjs/common';

import { DecisionModule } from '../decision/decision.module';
import { PolicyModule } from '../policy/policy.module';
import { ProfileBuilder } from './profile-builder.service';
import { ProfileInternalController } from './profile-internal.controller';
import { ProfileReader } from './profile-reader';
import { ResellerReader } from './reseller-reader';

@Module({
  imports: [PolicyModule, DecisionModule],
  controllers: [ProfileInternalController],
  providers: [ProfileReader, ResellerReader, ProfileBuilder],
})
export class ProfileModule {}
