-- F-707-k (ADR-0111 point 5, amended 2026-10-03 by the user). The seed is
-- sealed at the freeze, in the freeze's own transaction, beside the list hash:
-- once the list is frozen the outcome is fixed, and no crash, abort or rerun
-- can make a second seed. The draw (F-707-l) only applies the algorithm.
--
-- 1. `lottery_draw.drawnAt` is nullable: the close job writes the row at the
--    freeze with it null; the draw sets it, once.
-- 2. `lottery_draw_is_history` allows exactly two later writes, each once and
--    with every other column unchanged: `drawnAt` from null, then
--    `publishedAt` from null. A draw is published only after it is made.
--
-- Additive for existing rows (none in prod; every dev row has a `drawnAt`).
-- Rollback: SET NOT NULL after deleting undrawn rows, and the previous body
-- of the function from 20261003000200.

ALTER TABLE "engagement"."lottery_draw" ALTER COLUMN "drawnAt" DROP NOT NULL;

ALTER TABLE "engagement"."lottery_draw"
  ADD CONSTRAINT "lottery_draw_published_after_drawn" CHECK ("publishedAt" IS NULL OR "drawnAt" IS NOT NULL);

CREATE OR REPLACE FUNCTION engagement.lottery_draw_is_history() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'lottery_draw' THEN
    IF TG_OP = 'INSERT' THEN
      IF NOT EXISTS (SELECT 1 FROM engagement.lottery WHERE id = NEW."lotteryId" AND "status" IN ('published', 'frozen')) THEN
        RAISE EXCEPTION 'lottery_draw_is_history: a draw is made at the close of a published lottery' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END IF;
    -- Everything the freeze wrote is fixed; `drawnAt` and `publishedAt` are
    -- each set once, never cleared, never moved.
    IF TG_OP = 'UPDATE'
       AND (NEW."lotteryId", NEW."tenantId", NEW."entrantCount", NEW."skippedResellerCount", NEW."listHash", NEW."seedSealed",
            NEW."algorithm", NEW."frozenAt")
       IS NOT DISTINCT FROM (OLD."lotteryId", OLD."tenantId", OLD."entrantCount", OLD."skippedResellerCount", OLD."listHash",
            OLD."seedSealed", OLD."algorithm", OLD."frozenAt")
       AND (NEW."drawnAt" IS NOT DISTINCT FROM OLD."drawnAt" OR (OLD."drawnAt" IS NULL AND NEW."drawnAt" IS NOT NULL))
       AND (NEW."publishedAt" IS NOT DISTINCT FROM OLD."publishedAt" OR (OLD."publishedAt" IS NULL AND NEW."publishedAt" IS NOT NULL))
       AND (NEW."drawnAt", NEW."publishedAt") IS DISTINCT FROM (OLD."drawnAt", OLD."publishedAt") THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'lottery_draw_is_history: a draw is never changed; only its drawing and its publishing are recorded, once each' USING ERRCODE = '23514';
  END IF;
  -- lottery_winner
  IF TG_OP = 'UPDATE' AND (NEW."id", NEW."tenantId", NEW."lotteryId", NEW."entrantId", NEW."position")
       IS NOT DISTINCT FROM (OLD."id", OLD."tenantId", OLD."lotteryId", OLD."entrantId", OLD."position") THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'lottery_draw_is_history: a winner keeps its place in the draw' USING ERRCODE = '23514';
END
$$;
