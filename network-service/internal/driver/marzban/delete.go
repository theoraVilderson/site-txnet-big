package marzban

import (
	"context"
	"errors"
	"net/http"

	"network-service/internal/driver"
)

// DeleteClient disables the user, then deletes it (F-027-fl). Marzban 0.8.4's
// remove_user commits the delete and then raises on a user with no owner
// admin — every user the env sudo admin made — answering 500 before its
// background tasks run, Xray's removal among them, so the client went on
// serving unread. A disable goes through modify_user, whose Xray removal runs;
// a 5xx is then read back, and a user no longer there is a delete that landed.
func (d *Driver) DeleteClient(ctx context.Context, remoteID string) error {
	const op = "DeleteClient"
	if _, err := d.modify(ctx, op, remoteID, userBody{Status: status(false)}); err != nil {
		if notFound(err) {
			return nil
		}
		return err
	}
	err := d.call(ctx, op, http.MethodDelete, []string{"api", "user", remoteID}, nil, nil, nil)
	if err == nil || notFound(err) || !driver.IsUnavailable(err) {
		return ignoreNotFound(err)
	}
	if _, readErr := d.getUser(ctx, op, remoteID); notFound(readErr) {
		return nil
	}
	return err
}

// notFound is Marzban's 404: the user is not there.
func notFound(err error) bool {
	var fault *driver.Fault
	return errors.As(err, &fault) && fault.Status == http.StatusNotFound
}

func ignoreNotFound(err error) error {
	if notFound(err) {
		return nil
	}
	return err
}
