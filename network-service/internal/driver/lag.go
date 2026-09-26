package driver

import "time"

// DefaultEnforcementLag is the lag a family gets until its own is measured:
// the 3x-ui figure, because a family with no band serves its whole lag past a
// share, billed by nobody (F-027-co).
const DefaultEnforcementLag = 35 * time.Second

// enforcementLags is how long each family goes on serving a client after it
// crosses its ceiling. It is a property of the family, not of one panel: the
// panel's own loops set it, and the owner does not declare it (user,
// 2026-09-26).
//
// 3x-ui and its forks check traffic every 5 s, and a disable restarts Xray,
// which takes up to 30 s more (`restartXrayOnClientDisable`).
var enforcementLags = map[DriverType]time.Duration{
	DriverSanaee:     35 * time.Second,
	DriverThreeXUI:   35 * time.Second,
	DriverXUIAlireza: 35 * time.Second,
	DriverFake:       0,
}

// EnforcementLag is the seconds a panel of this family serves past a ceiling
// before it cuts. The ceiling written to it is the share less the config's
// rate over this lag (`contract.ceiling.md`, the guard band).
func (t DriverType) EnforcementLag() time.Duration {
	if lag, ok := enforcementLags[t]; ok {
		return lag
	}
	return DefaultEnforcementLag
}
