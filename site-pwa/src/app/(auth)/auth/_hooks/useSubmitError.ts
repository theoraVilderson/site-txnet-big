"use client";

import { useState } from "react";
import { ApiError, type ApiFieldError } from "@/lib/api-error";
import { useApiErrorMessage } from "@/hooks/useApiError";

export interface SubmitError {
  message: string;
  fieldErrors: ApiFieldError[];
  ref?: string;
}

/**
 * What an auth screen shows when a submit fails.
 *
 * Every one of these screens used to end its `catch` at `console.error`, which
 * left a wrong password, an expired code or a rate limit looking exactly like a
 * form that had simply stopped. `capture` keeps the log line — the browser
 * console is still where the stack belongs — and adds the part the user needs.
 */
export function useSubmitError() {
  const toMessage = useApiErrorMessage();
  const [error, setError] = useState<SubmitError | null>(null);

  return {
    error,
    /** Call before each attempt: the previous failure is no longer the answer. */
    clear: () => setError(null),
    capture: (e: unknown) => {
      console.error(e);
      setError({
        message: toMessage(e),
        fieldErrors: e instanceof ApiError ? e.fieldErrors : [],
        ref: e instanceof ApiError ? e.ref : undefined,
      });
    },
  };
}
