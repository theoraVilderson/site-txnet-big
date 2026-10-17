import { Pagination } from "./kit/Pagination";

/**
 * A job's refused and failed rows, a page at a time — a bulk job's
 * (F-311-u2) and a group move's (F-027-ev). Nothing while one page holds
 * them all, nor once billing purged them.
 */
export function JobProblemsPager({ page, count, pageSize, purged, onPage }: { page: number; count: number; pageSize: number; purged: boolean; onPage: (page: number) => void }) {
  if (purged || count <= pageSize) return null;
  return <Pagination page={page} totalPages={Math.ceil(count / pageSize)} totalItems={count} pageSize={pageSize} onPageChange={onPage} />;
}
