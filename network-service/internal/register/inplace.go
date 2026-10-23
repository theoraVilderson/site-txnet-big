package register

import (
	"context"
	"errors"
	"fmt"

	"network-service/internal/driver"
)

// ErrNoInPlacePanel is a panel an import may not read in place: not the
// tenant's, not of the run's family, not accepted, or retired.
var ErrNoInPlacePanel = errors.New("no accepted panel of the tenant and family")

// inPlaceSQL is one tenant's own accepted, live panel of a family, as the
// Opener needs it (F-1601-b1). A platform panel (tenantId null) is never one:
// an import reads the reseller's own router.
const inPlaceSQL = `
SELECT p.id::text, p."driverType"::text, p.transport::text, p."counterSemantics"::text,
       p."apiBaseUrl", coalesce(p."clientBaseUrl", ''), p."panelApiCredentials", p."tenantId"::text,
       p."knownAddresses", p."addressMayMove"
  FROM network.panel p
 WHERE p.id = $1::uuid AND p."tenantId" = $2::uuid AND p."driverType" = $3::network."DriverType"
   AND p."apiBaseUrl" IS NOT NULL
   AND p."reviewState" IN ('accepted', 'accepted_low_trust')
   AND p."retiredAt" IS NULL`

// InPlacePanels opens a tenant's registered panel for an import that reads it
// in place (ADR-0160): its users keep their login on it, so the snapshot is
// read with the panel's own login, through the guard and pin it was accepted
// with — never a source login typed for the run.
type InPlacePanels struct {
	DB     DB
	Opener Opener
}

// OpenInPlace builds the panel's driver, or ErrNoInPlacePanel.
func (p InPlacePanels) OpenInPlace(ctx context.Context, tenantID, panelID string, family driver.DriverType) (driver.Driver, error) {
	rows, err := p.DB.Query(ctx, inPlaceSQL, panelID, tenantID, string(family))
	if err != nil {
		return nil, fmt.Errorf("reading panel %s to read in place: %w", panelID, err)
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, fmt.Errorf("reading panel %s to read in place: %w", panelID, err)
		}
		return nil, fmt.Errorf("%w: panel %s", ErrNoInPlacePanel, panelID)
	}
	var reg Registered
	var fam, transport, semantics string
	if err := rows.Scan(&reg.PanelID, &fam, &transport, &semantics, &reg.APIBaseURL, &reg.ClientBaseURL, &reg.Credentials,
		&reg.TenantID, &reg.KnownAddresses, &reg.AddressMayMove); err != nil {
		return nil, fmt.Errorf("reading panel %s to read in place: %w", panelID, err)
	}
	reg.DriverType = driver.DriverType(fam)
	reg.Transport = driver.Transport(transport)
	reg.CounterSemantics = driver.CounterSemantics(semantics)
	reg.Pin = pinOf(reg)
	return p.Opener.Open(ctx, reg.Pending)
}
