package driver

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
)

// ReadEnvelope reads and closes an answer in the `{success, msg, obj}` shape
// the x-ui forks and S-UI share, decoding obj into out (nil: not decoded). A
// body cut off by our deadline is a timeout; success=false is RefusalFault's.
func ReadEnvelope(ctx context.Context, resp *http.Response, op string, out any) error {
	defer resp.Body.Close()
	var env struct {
		Success bool            `json:"success"`
		Msg     string          `json:"msg"`
		Obj     json.RawMessage `json:"obj"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&env); err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return NewFault(FaultTimeout, op, 0, fmt.Errorf("%w: %v", ctxErr, err))
		}
		return NewFault(FaultProtocol, op, 0, fmt.Errorf("decoding the answer: %w", err))
	}
	if !env.Success {
		return RefusalFault(op, resp.StatusCode, env.Msg)
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(env.Obj, out); err != nil {
		return NewFault(FaultProtocol, op, 0, fmt.Errorf("decoding obj: %w", err))
	}
	return nil
}
