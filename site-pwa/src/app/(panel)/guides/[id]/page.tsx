import { GuideEditor } from "../_components/GuideEditor";

/** `/guides/[id]` — one guide: its draft per language, placements, preview, publish (F-414-d). */
export default async function GuidePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <GuideEditor id={id} />;
}
