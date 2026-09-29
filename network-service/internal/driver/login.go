package driver

import (
	"fmt"
	"strings"
)

// LoginRefusalsToBlock is how many refused logins in a row it takes before
// credentials that once worked are called refused (user, 2026-09-29).
const LoginRefusalsToBlock = 3

// LoginRefusals classifies a refused login for a form-login family (x-ui and
// its forks). Those panels answer "wrong username or password" whenever the
// user lookup fails, and a locked SQLite fails it under load — seen on dev
// 2026-09-29, where one such answer took a working panel out for the whole
// cool-off. So credentials that already logged in on this driver are not
// called refused on one answer: the first refusals are `unavailable`, asked
// again on the next pass, and only LoginRefusalsToBlock in a row are
// `blocked`. Credentials that never worked are blocked on the first, as
// before. A driver is rebuilt when its panel row changes, so an edited
// password starts from "never worked".
//
// Not safe for concurrent use; the driver calls it under its login lock.
type LoginRefusals struct {
	worked bool
	streak int
}

// Succeeded records a login the panel accepted.
func (r *LoginRefusals) Succeeded() {
	r.worked = true
	r.streak = 0
}

// Refused records a refused login and returns its fault.
func (r *LoginRefusals) Refused(op string, status int, msg string) *Fault {
	r.streak++
	kind := FaultBlocked
	if r.worked && r.streak < LoginRefusalsToBlock {
		kind = FaultUnavailable
	}
	return NewFault(kind, op, status, fmt.Errorf("login refused (%d in a row): %s", r.streak, msg))
}

// RefusalFault classifies an API answer of success=false. A locked panel
// database is a panel too busy to answer, not an answer we cannot act on.
func RefusalFault(op string, status int, msg string) *Fault {
	kind := FaultProtocol
	if strings.Contains(strings.ToLower(msg), "database is locked") {
		kind = FaultUnavailable
	}
	return NewFault(kind, op, status, fmt.Errorf("panel refused: %s", msg))
}
