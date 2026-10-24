import { ReleaseFlagsView } from "./_components/ReleaseFlagsView";

/** `/release-flags` — a risky feature switched per tenant, without a deploy (OPS-1-ag, ADR-0164 point 4). */
export default function ReleaseFlagsPage() {
  return <ReleaseFlagsView />;
}
