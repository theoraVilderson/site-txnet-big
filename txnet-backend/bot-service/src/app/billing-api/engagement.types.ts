/**
 * The engagement routes' answers as the chat reads them (F-707-d/h/j/m/p):
 * the wheel and the lotteries, narrowed to what a chat tells.
 */

/** A prize's kind, as billing names it (`SpinPrizeType`, never `wallet_credit`). */
export type WheelPrizeType = 'bonus_traffic_gb' | 'extra_days' | 'discount_coupon' | 'free_grant' | 'empty';

/** `GET /api/billing/wheel` (`engagement/contract.md`, F-707-d): the public odds and whether this user may spin. */
export interface UserWheel {
  tenantDay: string;
  version: number;
  currencyCode: string;
  prizes: Array<{ position: number; label: string; prizeType: WheelPrizeType; prizeValue: string; oddsPercent: string }>;
  eligible: boolean;
  refusalReason: string | null;
  spinsLeftToday: number;
  nextSpinAt: string | null;
}

/** `GET /api/billing/lotteries` (`engagement/contract.md`, F-707-j): the lotteries this user sees, narrowed to what the chat tells. */
export interface ChatLottery {
  id: string;
  title: string;
  description: string | null;
  entryMode: 'automatic' | 'opt_in';
  status: 'published' | 'frozen' | 'drawn' | 'cancelled';
  closesAt: string;
  cancelReason: string | null;
  /** Published and before its close: a join or a leave is accepted now. */
  open: boolean;
  prizes: Array<{ rank: number; label: string; prizeType: WheelPrizeType; prizeValue: string; winnersCount: number }>;
  entry: { optedInAt: string | null; ticketNumber: number | null; excludedReason: string | null } | null;
}

export interface LotteryEntryAnswer {
  lotteryId: string;
  joined: boolean;
  replay: boolean;
}

/** `GET /api/billing/lotteries/:id/result` (F-707-m), narrowed to what the chat tells; the check itself is the panel's. */
export interface ChatLotteryResult {
  lotteryId: string;
  title: string;
  entrantCount: number;
  places: Array<{
    position: number;
    ticketNumber: number;
    prize: { rank: number; label: string } | null;
    delivery: 'pending' | 'delivered' | 'passed_on';
    passedOnReason: string | null;
    replacesPosition: number | null;
  }>;
  mine: { entrantId: string; ticketNumber: number | null; excludedReason: string | null } | null;
}

/** `POST /api/billing/wheel/spin`, narrowed to what the chat tells. A refused spin is a recorded `ok`. */
export interface SpinAnswer {
  attemptId: string;
  status: 'awarded' | 'voided_fraud' | 'rejected_ineligible';
  refusalReason: string | null;
  position: number | null;
  prize: { position: number; label: string; prizeType: WheelPrizeType; prizeValue: string } | null;
  reward: { grantId: string | null; coupon: { id: string; code: string; percent: string; expiresAt: string } | null } | null;
  replay: boolean;
}
