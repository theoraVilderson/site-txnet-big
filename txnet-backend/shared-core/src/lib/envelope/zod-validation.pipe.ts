import { BadRequestException, PipeTransform } from '@nestjs/common';
import type { ZodError, ZodSchema } from 'zod';

import { BackendI18nKeys } from '../i18n/keys.backend.generated';
import { isSafeKey } from './sanitize-error';

/**
 * Parses a request body with a zod schema, or refuses it with the envelope's
 * field errors (`sanitizeError`). A schema message is an i18n key in
 * `errors`; any other message — a zod default — becomes
 * `validation.invalidValue`, so the client still learns the field's path
 * (PK-1-j). One pipe for every Nest service (CS-1-l): it was six copies, one
 * per app, and they had begun to differ.
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

function fieldErrors(error: ZodError) {
  return error.issues.map((issue) => ({
    path: issue.path.join('.'),
    i18nKey: isSafeKey(issue.message) ? issue.message : BackendI18nKeys.errors.validation.invalidValue,
  }));
}
