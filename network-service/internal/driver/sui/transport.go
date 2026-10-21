package sui

import (
	"context"
	"net/http"
	"net/url"
	"strings"

	"network-service/internal/driver"
)

// get reads one API action with the current session. A 401 or 403 may be a
// session the panel forgot (a restart), so it is answered by one login and
// one retry; one that survives the fresh login is real.
func (d *Driver) get(ctx context.Context, op, action string, query url.Values, out any) error {
	d.mu.Lock()
	cookies := d.cookies
	d.mu.Unlock()
	var err error
	if cookies == nil {
		if cookies, err = d.login(ctx, op); err != nil {
			return err
		}
	}
	err = d.do(ctx, op, action, query, out, cookies)
	if kind, _ := driver.KindOf(err); kind != driver.FaultBlocked {
		return err
	}
	if cookies, err = d.login(ctx, op); err != nil {
		return err
	}
	return d.do(ctx, op, action, query, out, cookies)
}

// login posts S-UI's form (`user`, `pass`) and keeps whatever cookies the
// panel set. The request is not marked as the panel's ajax, so an expired
// session later is a 401 rather than a success=false like a refusal.
func (d *Driver) login(ctx context.Context, op string) ([]*http.Cookie, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.cookies = nil
	form := url.Values{"user": {d.creds.Username}, "pass": {d.creds.Password}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, d.base.JoinPath("api", "login").String(),
		strings.NewReader(form.Encode()))
	if err != nil {
		return nil, driver.NewFault(driver.FaultProtocol, op, 0, err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := driver.Send(ctx, d.http, op, req)
	if err != nil {
		return nil, err
	}
	if d.cookies, err = driver.FormLogin(resp, op, &d.refusals); err != nil {
		return nil, err
	}
	return d.cookies, nil
}

func (d *Driver) do(ctx context.Context, op, action string, query url.Values, out any, cookies []*http.Cookie) error {
	target := d.base.JoinPath("api", action)
	target.RawQuery = query.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return driver.NewFault(driver.FaultProtocol, op, 0, err)
	}
	for _, c := range cookies {
		req.AddCookie(c)
	}
	resp, err := driver.Send(ctx, d.http, op, req)
	if err != nil {
		return err
	}
	return driver.ReadEnvelope(ctx, resp, op, out)
}
