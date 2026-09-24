package sub

import (
	"fmt"
	"strconv"
)

// userinfo is `Subscription-Userinfo` (F-609, catalog §7.5): what a client
// app shows natively as used, remaining and expiry. Every `200` carries it.
//
// The Grant counts what its panels reported as one figure, `consumedBytes`,
// not split by direction, so all of it is `download` and `upload` is 0.
//
// `total` is the fixed cap, and an app reads 0 as unlimited:
//   - a prepaid Grant with a traffic quota: `quotas.traffic_bytes.limit` plus
//     its unexpired `traffic_bytes` QuotaAdjustments (a rollover shows here);
//     never below 1, so an adjustment past the limit is not read as unlimited.
//   - a metered Grant, or one with no traffic quota: 0. A metered Grant buys
//     its bytes in blocks just before they are used (ADR-0072), so
//     `purchasedBytes` would always look nearly empty.
//
// Used is the larger of the Grant as read and `live`, its total from
// `sub:usage:<grantId>` (F-609-b; 0 when there is none). Both only grow, so
// the larger is the newer, and a key that lags the row never lowers it.
//
// A Grant that is not active shows zero remaining: `download = total`, at
// least 1 for the same reason. `expire` is `endsAt` in Unix seconds, 0 when
// the Grant is permanent.
func userinfo(g Grant, live int64) string {
	used := max(g.ConsumedBytes, live, 0)
	var total int64
	if g.Status != "active" {
		used = max(used, 1)
		total = used
	} else if g.BillingMode == "prepaid" {
		if limit, err := strconv.ParseInt(g.TrafficLimit, 10, 64); err == nil {
			total = max(limit+g.TrafficAdjustment, 1)
		}
	}
	var expire int64
	if g.EndsAt != nil {
		expire = g.EndsAt.Unix()
	}
	return fmt.Sprintf("upload=0; download=%d; total=%d; expire=%d", used, total, expire)
}
