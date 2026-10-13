/**
 * The auth form's skeleton, shown while the route's bundle downloads and
 * hydrates so the form's place is never empty. Deliberately free of
 * framer-motion / lucide so it adds nothing to the bundle and appears at once.
 * Its shape matches login/register/forgot (header, tab bar, two fields,
 * captcha, button).
 */
export default function AuthLoading() {
  return (
    <div className="w-full animate-pulse" aria-hidden>
      {/* Header */}
      <div className="text-center mb-8 w-full flex flex-col items-center">
        <div className="h-8 w-40 rounded-lg bg-card-border/60 mb-3" />
        <div className="h-4 w-56 rounded bg-card-border/40" />
      </div>

      {/* Tab bar */}
      <div className="flex bg-tab-bg rounded-2xl p-1.5 mb-8 border border-card-border shadow-inner gap-1.5">
        <div className="flex-1 h-10 rounded-xl bg-card-border/40" />
        <div className="flex-1 h-10 rounded-xl bg-transparent" />
      </div>

      {/* Fields */}
      <div className="space-y-6 min-h-[150px]">
        <div className="h-14 w-full rounded-2xl border border-card-border bg-bg-inner" />
        <div className="h-14 w-full rounded-2xl border border-card-border bg-bg-inner" />
      </div>

      {/* Captcha */}
      <div className="mt-4 mb-4 h-[54px] w-full rounded-[27px] border-[1.5px] border-card-border bg-bg-inner" />

      {/* Button */}
      <div className="h-12 w-full rounded-2xl bg-primary/30" />
    </div>
  );
}
