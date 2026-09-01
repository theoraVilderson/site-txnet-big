import type { ResponseType } from '../../../../common/response/response.util';

/**
 * Replaces {{key}} placeholders inside an SMS template with given values.
 * Example: replaceVar("Your code: {{code}}", { code: "123456" })
 */
export function replaceVar(
  template: string,
  vars: Record<string, string | number>,
): string {
  return Object.entries(vars).reduce(
    (acc, [key, value]) =>
      acc.replace(new RegExp(`{{\\s*${key}\\s*}}`, 'g'), String(value)),
    template,
  );
}
