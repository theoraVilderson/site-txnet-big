package xuifamily

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"network-service/internal/driver"
)

// call sends one request with the current session. A status that may be an
// expired session (Dialect.ExpiryRedirects) is answered by one login and one
// retry; a refused login is not retried within the call, and is blocked once
// it repeats (driver.LoginRefusals, contract.budget.md). One that survives the
// fresh login is real.
func (d *Driver) call(ctx context.Context, op, method string, path []string, body, out any) error {
	cookies, err := d.currentSession(ctx, op)
	if err != nil {
		return err
	}
	err = d.do(ctx, op, method, path, body, out, cookies)
	var fault *driver.Fault
	if !errors.As(err, &fault) || !d.dialect.expired(fault.Status) {
		return err
	}
	if cookies, err = d.login(ctx, op); err != nil {
		return err
	}
	return d.do(ctx, op, method, path, body, out, cookies)
}

func (d *Driver) currentSession(ctx context.Context, op string) ([]*http.Cookie, error) {
	d.mu.Lock()
	cookies := d.cookies
	d.mu.Unlock()
	if cookies != nil {
		return cookies, nil
	}
	return d.login(ctx, op)
}

// login posts the form and keeps whatever cookies the panel set: the cookie's
// name has changed between versions, and no version is asked for.
func (d *Driver) login(ctx context.Context, op string) ([]*http.Cookie, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.cookies = nil
	form := url.Values{"username": {d.creds.Username}, "password": {d.creds.Password}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, d.base.JoinPath("login").String(),
		strings.NewReader(form.Encode()))
	if err != nil {
		return nil, driver.NewFault(driver.FaultProtocol, op, 0, err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	d.markAjax(req)
	resp, err := d.roundTrip(ctx, op, req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var env envelope
	if err := json.NewDecoder(resp.Body).Decode(&env); err != nil {
		return nil, driver.NewFault(driver.FaultProtocol, op, 0, fmt.Errorf("decoding the login answer: %w", err))
	}
	if !env.Success {
		return nil, d.refusals.Refused(op, resp.StatusCode, env.Msg)
	}
	if len(resp.Cookies()) == 0 {
		return nil, driver.NewFault(driver.FaultProtocol, op, 0, errors.New("login set no session cookie"))
	}
	d.refusals.Succeeded()
	d.cookies = resp.Cookies()
	return d.cookies, nil
}

// JSONRequest is a request to an x-ui panel with body, when there is one, as
// JSON. A failure to build it is a protocol fault of op.
func JSONRequest(ctx context.Context, op, method, target string, body any) (*http.Request, error) {
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return nil, driver.NewFault(driver.FaultProtocol, op, 0, err)
		}
		reader = strings.NewReader(string(raw))
	}
	req, err := http.NewRequestWithContext(ctx, method, target, reader)
	if err != nil {
		return nil, driver.NewFault(driver.FaultProtocol, op, 0, err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return req, nil
}

// markAjax marks the request as the panel's own ajax, so an expired session
// is a status code rather than a redirect — unless the dialect reads expiry
// from the redirect itself (Dialect.ExpiryRedirects).
func (d *Driver) markAjax(req *http.Request) {
	if !d.dialect.ExpiryRedirects {
		req.Header.Set("X-Requested-With", "XMLHttpRequest")
	}
}

func (d *Driver) do(ctx context.Context, op, method string, path []string, body, out any, cookies []*http.Cookie) error {
	req, err := JSONRequest(ctx, op, method, d.base.JoinPath(path...).String(), body)
	if err != nil {
		return err
	}
	d.markAjax(req)
	for _, c := range cookies {
		req.AddCookie(c)
	}
	resp, err := d.roundTrip(ctx, op, req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	var env envelope
	if err := json.NewDecoder(resp.Body).Decode(&env); err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return driver.NewFault(driver.FaultTimeout, op, 0, fmt.Errorf("%w: %v", ctxErr, err))
		}
		return driver.NewFault(driver.FaultProtocol, op, 0, fmt.Errorf("decoding the answer: %w", err))
	}
	if !env.Success {
		return driver.RefusalFault(op, resp.StatusCode, env.Msg)
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(env.Obj, out); err != nil {
		return driver.NewFault(driver.FaultProtocol, op, 0, fmt.Errorf("decoding obj: %w", err))
	}
	return nil
}

// roundTrip is where every transport and status failure is classified
// (driver.Fault). A success=false inside a 200 is classified by the caller.
func (d *Driver) roundTrip(ctx context.Context, op string, req *http.Request) (*http.Response, error) {
	resp, err := d.http.Do(req)
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, driver.NewFault(driver.FaultTimeout, op, 0, fmt.Errorf("%w: %v", ctxErr, err))
		}
		return nil, driver.NewFault(driver.FaultUnavailable, op, 0, err)
	}
	if resp.StatusCode >= 300 {
		defer resp.Body.Close()
		detail, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		fault := driver.FaultForStatus(op, resp.StatusCode, fmt.Errorf("%s", strings.TrimSpace(string(detail))))
		if seconds, err := strconv.Atoi(resp.Header.Get("Retry-After")); err == nil && seconds > 0 {
			fault.RetryAfter = time.Duration(seconds) * time.Second
		}
		return nil, fault
	}
	return resp, nil
}

func (d *Driver) list(ctx context.Context, op string) ([]inbound, time.Time, error) {
	var list []inbound
	if err := d.call(ctx, op, http.MethodGet, d.dialect.List, nil, &list); err != nil {
		return nil, time.Time{}, err
	}
	return list, time.Now(), nil
}

// find reads the panel and returns one client. ok is false when no inbound
// holds it.
func (d *Driver) find(ctx context.Context, op, remoteID string) (found, bool, error) {
	list, _, err := d.list(ctx, op)
	if err != nil {
		return found{}, false, err
	}
	all, err := clients(op, list)
	if err != nil {
		return found{}, false, err
	}
	for _, f := range all {
		if f.client.Email == remoteID {
			return f, true, nil
		}
	}
	return found{}, false, nil
}

func (d *Driver) mustFind(ctx context.Context, op, remoteID string) (found, error) {
	f, ok, err := d.find(ctx, op, remoteID)
	if err == nil && !ok {
		err = driver.NewFault(driver.FaultProtocol, op, http.StatusNotFound, fmt.Errorf("no client %q on the panel", remoteID))
	}
	return f, err
}

// write sends the whole client, as it should now be, to the inbound it lives
// on. A dialect that holds the reset writes it 0 every time (Dialect.HoldsReset).
func (d *Driver) write(ctx context.Context, op string, path []string, inboundID int, c client) error {
	c.Reset = nil
	if d.dialect.HoldsReset {
		zero := 0
		c.Reset = &zero
	}
	settings, err := json.Marshal(map[string][]client{"clients": {c}})
	if err != nil {
		return driver.NewFault(driver.FaultProtocol, op, 0, err)
	}
	body := map[string]any{"id": inboundID, "settings": string(settings)}
	return d.call(ctx, op, http.MethodPost, path, body, nil)
}

// update applies change to the client as the panel holds it now, and writes
// it back to the key the panel knows it by.
func (d *Driver) update(ctx context.Context, op, remoteID string, change func(*client)) error {
	f, err := d.mustFind(ctx, op, remoteID)
	if err != nil {
		return err
	}
	key := f.key()
	next := f.client
	change(&next)
	return d.write(ctx, op, d.inbounds("updateClient", key), f.inbound.ID, next)
}
