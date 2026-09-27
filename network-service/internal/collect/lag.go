package collect

import (
	"time"

	"network-service/internal/lease/quota"
)

// EnforcementLag is how long this panel serves past a ceiling — the lag the
// guard band covers (`contract.ceiling.md`). Once the lease planner has
// measured one on this panel it is the planner's own reserve, mean + LagZ·σ
// (F-027-cz), so the band and the planner budget the same seconds; until then
// it is the family's figure (F-027-co), because a panel with no band serves
// its whole lag past a share.
func (p Panel) EnforcementLag() time.Duration {
	if p.LagSamples <= 0 {
		return p.DriverType.EnforcementLag()
	}
	lag := quota.NewLag(0) // no floor; the planner's 10 min ceiling
	lag.Mean, lag.Var, lag.N = p.LagMeanSec, p.LagVarianceSec2, p.LagSamples
	return lag.Reserve(quota.DefaultParams().LagZ)
}
