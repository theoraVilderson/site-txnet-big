import { AgentThreadView } from "../../_components/AgentThreadView";

/** `/support/inbox/[id]` — one conversation as an agent sees it: notes, actions, the user's sidebar (F-033-p). */
export default async function AgentThreadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AgentThreadView id={id} />;
}
