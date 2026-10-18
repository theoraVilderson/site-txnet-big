import { PackageDetailView } from "../_components/PackageDetailView";

/** `/resellers/packages/[id]` — one package, every section edited in its own sheet (PK-1-f, ADR-0154 (2)). */
export default async function ResellerPackagePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PackageDetailView id={id} />;
}
