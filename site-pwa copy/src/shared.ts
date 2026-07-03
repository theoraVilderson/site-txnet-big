export type ErrorResponse<E> = {
  ok: false;
  msg: string;
  error: E;
};
export type SuccessResponse<T> = {
  ok: true;
  msg: string;
  data: T;
};
export function ok<T>(data: T, msg = "successful"): SuccessResponse<T> {
  return {
    ok: true,
    msg,
    data,
  };
}

export type ResponseType<T, E = unknown> =
  | ErrorResponse<E>
  | SuccessResponse<T>;

export function err<E>(msg = "failed", error = null as E): ErrorResponse<E> {
  return {
    ok: false,
    msg,
    error,
  };
}

export async function safeExecute<T>(
  action: Promise<T> | (() => Promise<T> | T),
  customErrorMessage?: string,
): Promise<ResponseType<T>> {
  try {
    const result = typeof action === "function" ? await action() : await action;

    if (result && typeof result === "object" && "ok" in result) {
      return result as ResponseType<T>;
    }

    return ok(result);
  } catch (e: unknown) {
    const baseMsg = e instanceof Error ? e.message : String(e);
    const finalMsg = customErrorMessage
      ? `${customErrorMessage}: ${baseMsg}`
      : baseMsg;

    return err(finalMsg, e);
  }
}

export function addTimeFromNow(addNumber: number) {
  return Date.now() + addNumber * 1000;
}
