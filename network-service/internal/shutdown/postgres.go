package shutdown

import (
	"context"
	"fmt"

	"network-service/internal/collect"
)

// PostgresReserves is Reserves over `network.config` (F-027-bv): the figures
// `billing-service` leaves on the row (ADR-0078), read once per panel on the
// way out. `MemoryReserves` stays as what the extension is proved against.
type PostgresReserves struct {
	DB collect.DB
}

var _ Reserves = PostgresReserves{}

// reservesSQL is the ceiling pass's population with a wallet-backed figure
// beside its share. A config billing has not sized has no figure, and is left
// where it is: an extension is bounded by money somebody computed, never by a
// guess made on the way out. A disabled config is not raised — a suspension
// has to hold across a deploy too, and so does the lease planner's close
// (F-027-dd).
const reservesSQL = `
SELECT c.id::text, c."remoteId", c."allocatedCeilingBytes", c."walletBackedCeilingBytes",
       coalesce(c."observedRateBps", 0)::bigint
  FROM network.config c
 WHERE c."panelId" = $1::uuid
   AND c."remoteId" IS NOT NULL
   AND c."desiredRemote" = 'present'
   AND c."desiredEnabled"
   AND NOT EXISTS (SELECT 1 FROM network.lease_close l WHERE l."grantId" = c."grantId")
   AND c."allocatedCeilingBytes" IS NOT NULL
   AND c."walletBackedCeilingBytes" IS NOT NULL
 ORDER BY c."createdAt", c.id`

func (s PostgresReserves) Extensions(ctx context.Context, panelID string) ([]Extension, error) {
	rows, err := s.DB.Query(ctx, reservesSQL, panelID)
	if err != nil {
		return nil, fmt.Errorf("reading panel %s reserves: %w", panelID, err)
	}
	defer rows.Close()
	var out []Extension
	for rows.Next() {
		var e Extension
		if err := rows.Scan(&e.ConfigID, &e.RemoteID, &e.AllocatedBytes, &e.WalletBackedBytes, &e.RateBps); err != nil {
			return nil, fmt.Errorf("reading panel %s reserves: %w", panelID, err)
		}
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("reading panel %s reserves: %w", panelID, err)
	}
	return out, nil
}
