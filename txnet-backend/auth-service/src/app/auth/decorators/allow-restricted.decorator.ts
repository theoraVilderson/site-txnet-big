import { SetMetadata } from '@nestjs/common';

export const ALLOW_RESTRICTED = 'auth:allowRestricted';

/**
 * A restricted account (`suspended`, ADR-0133) may call this handler, or every
 * handler of this controller. `AuthGuard` refuses a restricted token anywhere
 * unmarked, so mark only what the restricted screen needs: who the caller is
 * (`me`), the switcher, and the panel's own boot reads.
 */
export const AllowRestricted = () => SetMetadata(ALLOW_RESTRICTED, true);
