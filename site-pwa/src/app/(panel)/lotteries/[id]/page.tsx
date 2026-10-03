import { LotteryResultView } from "../_components/LotteryResultView";

/** `/lotteries/[id]` — one drawn lottery's result, and the user's own check of the draw (F-707-n). */
export default async function LotteryResultPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <LotteryResultView id={id} />;
}
