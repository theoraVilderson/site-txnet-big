"use client";

/**
 * One of the two numbers a service is read by — traffic left, time left —
 * as a headline, a bar and a line under it (F-307-c). Drawn from the row
 * itself, so it costs no read.
 *
 * `share` is how much is spent, in [0, 1], or `null` for nothing to be a share
 * of (unlimited traffic or time): then there is no bar, only the headline. A
 * sliver of use still shows, because a bar that reads empty at 0.3% looks
 * unmetered; a full one turns red.
 */
export function Meter({
  title,
  headline,
  detail,
  share,
  label,
}: {
  title: string;
  headline: string;
  detail?: string;
  share: number | null;
  /** The whole sentence for a screen reader, when there is a bar. */
  label?: string;
}) {
  const drawn = share === null ? 0 : share === 0 ? 0 : Math.max(share, 0.02);
  const full = share !== null && share >= 1;

  return (
    <div className="min-w-0 rounded-2xl bg-bg-inner p-3">
      <p className="text-xs text-text-secondary">{title}</p>
      <p className={`mt-0.5 text-lg font-black ${full ? "text-error" : "text-text-primary"}`}>{headline}</p>
      {share !== null && (
        <div
          role="img"
          aria-label={label}
          title={label}
          className="mt-2 h-2 w-full overflow-hidden rounded-full bg-card-border"
        >
          <div
            className={`h-full rounded-full ${full ? "bg-error" : "bg-primary"}`}
            style={{ width: `${drawn * 100}%` }}
          />
        </div>
      )}
      {detail && <p className="mt-2 text-xs text-text-secondary">{detail}</p>}
    </div>
  );
}
