import { AlertCircle } from "lucide-react";

/** Billing's sentence for a refused read or act on a service, and its ref for support. */
export function RefusalNote({ error, className = "" }: { error: { message: string; ref?: string }; className?: string }) {
  return (
    <div role="alert" className={`${className} flex items-start gap-2 rounded-2xl border border-error-border bg-error-bg px-3 py-2 text-xs font-medium text-error`}>
      <AlertCircle size={14} className="mt-0.5 shrink-0" aria-hidden />
      <span className="min-w-0">
        {error.message}
        {error.ref && (
          <span className="mt-1 block font-mono text-3xs opacity-70" dir="ltr">
            {error.ref}
          </span>
        )}
      </span>
    </div>
  );
}
