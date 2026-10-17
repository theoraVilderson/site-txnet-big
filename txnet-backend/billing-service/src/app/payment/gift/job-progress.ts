/** A job's row as both kinds keep it: a bulk job by filter (F-311-u2) and a config move job (F-311-ad). */
type JobRow = {
  status: string;
  total: number;
  okCount: number;
  refusedCount: number;
  failedCount: number;
  createdAt: Date;
  finishedAt: Date | null;
  purgedAt: Date | null;
};

/** Where a job stands, as its page reads it: the fixed denominator, what is done of it, and when it ended or was purged. */
export function jobProgress<S extends string>(j: JobRow & { status: S }) {
  return {
    status: j.status,
    total: j.total,
    processed: j.okCount + j.refusedCount + j.failedCount,
    ok: j.okCount,
    refused: j.refusedCount,
    failed: j.failedCount,
    createdAt: j.createdAt.toISOString(),
    finishedAt: j.finishedAt?.toISOString() ?? null,
    purgedAt: j.purgedAt?.toISOString() ?? null,
  };
}

/** What `jobProgress` answers. */
export type JobProgress<S extends string> = ReturnType<typeof jobProgress<S>>;
