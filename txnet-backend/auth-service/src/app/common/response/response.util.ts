/**
 * Standard API response types and helper functions.
 * All messages are i18n keys; translation is handled by interceptor/filter.
 */
import {
  HttpException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';

const safeExecuteLogger = new Logger('safeExecute');

export type ErrorResponse<E> = {
  ok: false;
  msg: string; // i18n key
  error: E;
};

export type SuccessResponse<T> = {
  ok: true;
  msg: string; // i18n key
  data: T;
};

export type ResponseType<T, E = unknown> =
  | ErrorResponse<E>
  | SuccessResponse<T>;

/**
 * Creates a success response.
 * @param data The payload to return.
 * @param msg The i18n key for success message.
 */
export function ok<T>(data: T, msg = 'successful'): SuccessResponse<T> {
  return {
    ok: true,
    msg,
    data,
  };
}

/**
 * Creates an error response.
 * @param msg The i18n key for error message.
 * @param error Optional error payload.
 */
export function err<E>(msg = 'failed', error = null as E): ErrorResponse<E> {
  return {
    ok: false,
    msg,
    error,
  };
}

/**
 * Runs `action` and wraps the result in ok(). If it already returns an
 * `{ ok }` object, it's passed through unchanged.
 *
 * On error the raw error is NEVER returned to the caller/client:
 *   - an HttpException (a deliberate business error, i18n key inside) is rethrown
 *     as-is so the global filter can sanitize + translate it;
 *   - anything else (DB / third-party / bug) is logged server-side and rethrown
 *     as an opaque error — the global filter turns it into `system.unexpected`.
 *
 * @param customErrorKey Optional i18n key to use instead of the generic one.
 */
export async function safeExecute<T>(
  action: Promise<T> | (() => Promise<T> | T),
  customErrorKey?: string,
): Promise<ResponseType<T>> {
  try {
    const result = typeof action === 'function' ? await action() : await action;

    if (result && typeof result === 'object' && 'ok' in result) {
      return result as ResponseType<T>;
    }
    return ok(result);
  } catch (e: unknown) {
    if (e instanceof HttpException) throw e;

    safeExecuteLogger.error(
      `unhandled error in safeExecute: ${
        e instanceof Error ? (e.stack ?? e.message) : String(e)
      }`,
    );
    throw customErrorKey
      ? new HttpException({ i18nKey: customErrorKey }, 400)
      : new InternalServerErrorException();
  }
}
