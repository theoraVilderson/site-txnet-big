// app/finance/loading.tsx
import { TableSkeleton } from "./TableSkeleton";

export default function Loading() {
  return (
    <div className="min-h-screen p-4 md:p-8 max-w-7xl mx-auto space-y-6">
      <TableSkeleton />
    </div>
  );
}
