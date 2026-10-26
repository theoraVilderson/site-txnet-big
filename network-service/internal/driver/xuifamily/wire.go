package xuifamily

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strconv"
	"time"

	"network-service/internal/driver"
)

// client is one element of an inbound's settings.clients. Fields this driver
// does not own (tgId, flow) are carried through a write unchanged; limitIp is
// the Grant's device limit (F-311-q). Comment is the claim tag; a fork that
// stores the map as sent keeps it without reading it. Reset is sent only by a
// dialect that holds it (Dialect.HoldsReset).
type client struct {
	ID         string `json:"id,omitempty"`
	Password   string `json:"password,omitempty"`
	Email      string `json:"email"`
	Enable     bool   `json:"enable"`
	TotalGB    int64  `json:"totalGB"`
	ExpiryTime int64  `json:"expiryTime"`
	Comment    string `json:"comment,omitempty"`
	SubID      string `json:"subId"`
	Reset      *int   `json:"reset,omitempty"`
	LimitIP    int    `json:"limitIp"`
	TgID       any    `json:"tgId,omitempty"`
	Flow       string `json:"flow,omitempty"`
	Security   string `json:"security,omitempty"`
}

type clientStat struct {
	Email string `json:"email"`
	Up    int64  `json:"up"`
	Down  int64  `json:"down"`
	Total int64  `json:"total"`
}

// Inbound is one row of the panel's inbound list as every x-ui shape lists
// it, v3 (package threexui) included.
type Inbound struct {
	ID       int    `json:"id"`
	Enable   bool   `json:"enable"`
	Port     int    `json:"port"`
	Protocol string `json:"protocol"`
	Tag      string `json:"tag"`
	// Listen, Remark, Settings and StreamSettings are what a client's line is
	// built from (ClientLinks, ADR-0088), and the fingerprint an edit is seen by.
	Listen         string `json:"listen"`
	Remark         string `json:"remark"`
	Settings       JSONText `json:"settings"`
	StreamSettings JSONText `json:"streamSettings"`
}

// JSONText is a JSON value x-ui answers as its text (v2, early v3) or, since
// 3.11, as the value itself: kept as text either way, the bytes as the panel
// sent them, so a line and a fingerprint are built from one form.
type JSONText string

// UnmarshalJSON takes a JSON string as its contents and any other value as written.
func (t *JSONText) UnmarshalJSON(b []byte) error {
	switch {
	case len(b) > 0 && b[0] == '"':
		var s string
		if err := json.Unmarshal(b, &s); err != nil {
			return err
		}
		*t = JSONText(s)
	case string(b) == "null":
		*t = ""
	default:
		*t = JSONText(b)
	}
	return nil
}

// InboundsOf is the list as driver.Inbound rows, ordered by tag.
func InboundsOf(list []Inbound) []driver.Inbound {
	out := make([]driver.Inbound, 0, len(list))
	for _, in := range list {
		out = append(out, driver.Inbound{
			RemoteID: strconv.Itoa(in.ID), Tag: in.Tag, Protocol: in.Protocol, Port: in.Port, Enabled: in.Enable,
			Fingerprint: driver.XrayFingerprint(driver.XrayInbound{
				Listen: in.Listen, Port: in.Port, Protocol: in.Protocol, Remark: in.Remark,
				Settings: string(in.Settings), StreamSettings: string(in.StreamSettings),
			}),
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Tag < out[j].Tag })
	return out
}

// inbound is a v2-shaped row: an Inbound with its clients' counters in it.
type inbound struct {
	Inbound
	ClientStats []clientStat `json:"clientStats"`
}

// found is one client where the panel holds it: its settings, its counters,
// and the inbound it belongs to.
type found struct {
	inbound  inbound
	client   client
	stat     clientStat
	hasStat  bool
	protocol string
}

// key is what the panel finds a client by in updateClient and delClient: the
// uuid, or the password of a trojan client.
func (f found) key() string {
	if f.protocol == "trojan" {
		return f.client.Password
	}
	return f.client.ID
}

func (f found) remote() driver.RemoteClient {
	c := driver.RemoteClient{
		RemoteID:        f.client.Email,
		Label:           f.client.Comment,
		UUID:            f.client.ID + f.client.Password,
		InboundRemoteID: strconv.Itoa(f.inbound.ID),
		Enabled:         f.client.Enable,
		DataLimitBytes:  f.client.TotalGB,
		IPLimit:         f.client.LimitIP,
		TelegramID:      telegramIDOf(f.client.TgID),
	}
	// The counters' row is what the panel's depletion job checks, so its total
	// is the ceiling actually enforced; the settings copy is only its source.
	if f.hasStat {
		c.DataLimitBytes = f.stat.Total
	}
	// A negative expiry is a delayed start in days, not a date.
	if f.client.ExpiryTime > 0 {
		c.ExpiresAt = time.UnixMilli(f.client.ExpiryTime).UTC()
	}
	return c
}

// telegramIDOf reads tgId as the forks store it: a JSON number, or the
// string a form saved it as (F-210). A fractional number is no id.
func telegramIDOf(v any) string {
	switch id := v.(type) {
	case float64:
		if id != math.Trunc(id) {
			return ""
		}
		return driver.TelegramIDOfNumber(int64(id))
	case string:
		return driver.TelegramIDOf(id)
	}
	return ""
}

// clients flattens every inbound's clients. An inbound whose settings do not
// parse is a protocol fault: skipping it would drop its clients from a pass.
func clients(op string, list []inbound) ([]found, error) {
	var out []found
	for _, in := range list {
		var settings struct {
			Clients []client `json:"clients"`
		}
		if err := json.Unmarshal([]byte(in.Settings), &settings); err != nil {
			return nil, driver.NewFault(driver.FaultProtocol, op, 0,
				fmt.Errorf("inbound %d settings: %w", in.ID, err))
		}
		stats := make(map[string]clientStat, len(in.ClientStats))
		for _, s := range in.ClientStats {
			stats[s.Email] = s
		}
		for _, c := range settings.Clients {
			s, ok := stats[c.Email]
			out = append(out, found{inbound: in, client: c, stat: s, hasStat: ok, protocol: in.Protocol})
		}
	}
	return out, nil
}

// Ceiling is a ceiling as an x-ui panel must be told it: never 0, which it reads
// as unlimited (package doc).
func Ceiling(bytes int64) int64 {
	if bytes < 1 {
		return driver.CutOffBytes
	}
	return bytes
}

// Limit is the figure a create or an update writes: the panel's own 0 for a
// client wanted with no limit (F-111-r), a ceiling otherwise.
func Limit(none bool, bytes int64) int64 {
	if none {
		return 0
	}
	return Ceiling(bytes)
}

// Expiry is an expiry as the panel stores it: milliseconds, 0 for none.
func Expiry(at time.Time) int64 {
	if at.IsZero() {
		return 0
	}
	return at.UnixMilli()
}

func credential(c *client, protocol, id string) {
	c.ID, c.Password = "", ""
	if protocol == "trojan" {
		c.Password = id
	} else {
		c.ID = id
	}
}

// NewSubID is the client's subscription token. It is a secret — whoever has
// it has the client's links — so it is random, not derived.
func NewSubID() (string, error) {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	for i, b := range raw {
		raw[i] = alphabet[int(b)%len(alphabet)]
	}
	return string(raw), nil
}

func isProtocol(p string) bool {
	for _, known := range protocols {
		if p == known {
			return true
		}
	}
	return false
}
