import { BadRequestException, PipeTransform } from '@nestjs/common';
import { BackendI18nKeys, isSafeKey } from '@txnet-backend/shared-core';
import type { ZodError, ZodSchema } from 'zod';

/**
 * Parses a request body with a zod schema, or refuses it with the envelope's
 * field errors (`shared-core` `sanitizeError`). A schema message is an i18n key
 * in `errors`; any other message — a zod default — becomes `validation.invalidValue`.
 *
 * `auth-service`'s `common/pipes/zod-validation.pipe.ts` is the twin; an app
 * cannot import an app. `billing-service` and `notification-service` hold the others.
 */
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodSchema) {}

  transform(value: unknown) {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        i18nKey: BackendI18nKeys.errors.validation.failed,
        fieldErrors: fieldErrors(result.error),
      });
    }
    return result.data;
  }
}

// A message that is not a locale key (zod's own English default) is answered
// with a generic one, so the envelope keeps the path the client goes to (PK-1-j).
function fieldErrors(error: ZodError) {
  return error.issues.map((issue) => ({
    path: issue.path.join('.'),
    i18nKey: isSafeKey(issue.message) ? issue.message : BackendI18nKeys.errors.validation.invalidValue,
  }));
}
