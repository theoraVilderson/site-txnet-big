import { BadRequestException, PipeTransform } from '@nestjs/common';
import { ZodSchema, ZodError } from 'zod';

/**
 * Transforms and validates request body using Zod schema.
 * All error messages are i18n keys.
 */
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodSchema) {}

  transform(value: unknown) {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        i18nKey: 'validation.failed',
        fieldErrors: this.formatErrors(result.error),
      });
    }
    return result.data;
  }

  private formatErrors(error: ZodError) {
    return error.issues.map((issue) => ({
      path: issue.path.join('.'),
      i18nKey: issue.message, // i18n key embedded in schema messages
    }));
  }
}
