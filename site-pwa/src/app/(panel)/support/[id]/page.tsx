import { SupportThreadView } from "../_components/SupportThreadView";

/** `/support/[id]` — one conversation, live over `support:<id>` (F-033-o, F-034). */
export default async function SupportThreadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SupportThreadView id={id} />;
}
