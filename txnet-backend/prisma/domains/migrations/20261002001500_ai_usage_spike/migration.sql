-- F-1516: a Grant whose last 24 h of use is 3x its usual day (usage_alert).
ALTER TYPE "ai"."AiPredictionKind" ADD VALUE IF NOT EXISTS 'usage_spike';
