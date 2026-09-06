/* eslint-disable */
// Runs in every worker before the test framework is installed — early enough
// that `AppModule`'s ConfigModule sees the e2e environment.
import { applyE2eEnv } from './env';

applyE2eEnv();
