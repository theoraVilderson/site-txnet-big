import { LotteryAdminDetail } from "../_components/LotteryAdminDetail";

/** `/lotteries/manage/[id]` — one lottery: edit, publish, cancel, who enters, the winners (F-707-o). */
export default async function LotteryAdminDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <LotteryAdminDetail id={id} />;
}
