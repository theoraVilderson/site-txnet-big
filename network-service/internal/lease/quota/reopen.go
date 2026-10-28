package quota

import "time"

// returnReserve is what a device coming back at the account's recent peak
// takes through the slowest panel's lag before the ceiling cuts it
// (LIVE-1-u). Once the demand that closed it has aged, a settled close
// reopens only on a rest at least this big, so a returning burst cannot
// take more past the bag than it was owed.
func (a *Account) returnReserve(vs []*view) Bytes {
	var lag time.Duration
	for _, v := range vs {
		lag = max(lag, v.lag)
	}
	return toBytes(a.PeakReplica * lag.Seconds())
}
