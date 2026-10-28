package threexui

import (
	"time"

	"network-service/internal/driver/xuifamily"
)

// limited is a client 3x-ui's depletion job switched off at its total or
// expiry (LIVE-1-y), read from the counters row the job checks.
func (r record) limited(at time.Time) bool {
	var used, total int64
	if r.Traffic != nil {
		used, total = r.Traffic.Up+r.Traffic.Down, r.Traffic.Total
	}
	return xuifamily.Limited(r.Enable, used, total, r.ExpiryTime, at)
}
