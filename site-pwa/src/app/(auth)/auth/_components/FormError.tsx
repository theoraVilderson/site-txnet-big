"use client";

import { motion, AnimatePresence } from "framer-motion";
import type { ApiFieldError } from "@/lib/api-error";

/**
 * The one place an auth screen says that something went wrong.
 *
 * Both `message` and every `fieldErrors[].message` arrive already translated by
 * `auth-api` (see `useApiErrorMessage`), so this component only lays them out.
 * It is `role="alert"` because it appears after a submit the user is waiting
 * on: a screen reader has to announce it without being asked.
 */
export function FormError({
  message,
  fieldErrors = [],
  reference,
}: {
  message: string | null;
  fieldErrors?: ApiFieldError[];
  /** The server's correlation id, when it sent one — worth quoting to support. */
  reference?: string;
}) {
  return (
    <AnimatePresence mode="wait">
      {message && (
        <motion.div
          key="form-error"
          role="alert"
          aria-live="assertive"
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.18 }}
          className="mb-4 rounded-xl border border-error-border bg-error-bg px-4 py-3 text-sm font-medium text-error"
        >
          <p>{message}</p>
          {fieldErrors.length > 0 && (
            <ul className="mt-2 space-y-1 text-xs font-normal opacity-90">
              {fieldErrors.map((f) => (
                <li key={`${f.path}:${f.message}`}>{f.message}</li>
              ))}
            </ul>
          )}
          {reference && (
            <p className="mt-2 font-mono text-[0.65rem] opacity-70" dir="ltr">
              {reference}
            </p>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
