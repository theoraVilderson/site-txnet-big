package sub

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

// How a served line is named (F-307-h, ADR-0089): the name a VPN app shows
// for it, set as the body is built and never written to a panel.
//
// Billing's config list names the same stored lines in TypeScript, so the
// rule is declared in `contracts/network/line-names.json` and each side is
// held to it by its own test (line_names_test.go here). A change here is a
// change there.

// platformLineNameTemplate is the default name when a tenant has set no
// template of its own: the panel's region, e.g. `آلمان`.
const platformLineNameTemplate = "{region}"

// LineNaming is a tenant's part in naming its lines (F-307-j, ADR-0089 rule
// 4): its template, empty for the platform's, and its brand name. What a
// template may hold is tenant-service's rule; here it is only evaluated.
type LineNaming struct {
	Template string
	Brand    string
}

// base is a line's name from the template, `{brand}` and `{region}` replaced
// in one pass (a brand name holding `{region}` stays as written), then
// trimmed; empty keeps the panel's own name.
func (n LineNaming) base(region string) string {
	t := n.Template
	if t == "" {
		t = platformLineNameTemplate
	}
	return strings.TrimSpace(strings.NewReplacer("{brand}", n.Brand, "{region}", region).Replace(t))
}

var (
	uriLine      = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9+.-]*://`)
	vmessPayload = regexp.MustCompile(`^[A-Za-z0-9+/=_-]+$`)
)

// named reports whether a config takes part in its Grant's naming: not
// retired, and its lines are its current client's. It is the list billing
// shows, taken before serves() drops what `/sub` does not serve, so both
// number a line alike (ADR-0089 rule 3).
func named(c Config) bool {
	return c.Status != "retired" && c.LinksUUID != "" && c.LinksUUID == c.UUID
}

// lineNamesOfGrant is the name of every line of a Grant, config by config in
// the store's order. A config outside the naming list gets none; nil keeps
// the panel's own name. A name already given gets " 2", " 3", ... (the first
// free).
func lineNamesOfGrant(configs []Config, naming LineNaming) [][]*string {
	given := map[string]bool{}
	out := make([][]*string, len(configs))
	for i, c := range configs {
		if !named(c) {
			continue
		}
		base := c.UserLabel
		if base == "" {
			base = naming.base(c.Region)
		}
		out[i] = make([]*string, len(c.LinkLines))
		if base == "" {
			continue
		}
		for j := range c.LinkLines {
			name := base
			for n := 2; given[name]; n++ {
				name = fmt.Sprintf("%s %d", base, n)
			}
			given[name] = true
			out[i][j] = &name
		}
	}
	return out
}

// nameLine is line carrying name: `ps` of a `vmess://` base64 JSON line,
// else the `#fragment` of any `scheme://` line; any other line unchanged.
func nameLine(line, name string) string {
	if payload, ok := strings.CutPrefix(line, "vmess://"); ok {
		if renamed, ok := nameVmess(payload, name); ok {
			return "vmess://" + renamed
		}
	}
	if !uriLine.MatchString(line) {
		return line
	}
	if i := strings.IndexByte(line, '#'); i >= 0 {
		line = line[:i]
	}
	return line + "#" + encodeURIComponent(name)
}

// nameVmess is the base64 JSON with `ps` set; false when it is not a base64
// JSON object. Numbers are kept as written (UseNumber).
func nameVmess(payload, name string) (string, bool) {
	if !vmessPayload.MatchString(payload) {
		return "", false
	}
	var raw []byte
	for _, enc := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding, base64.RawURLEncoding} {
		if b, err := enc.DecodeString(payload); err == nil {
			raw = b
			break
		}
	}
	if raw == nil {
		return "", false
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var obj map[string]any
	if err := dec.Decode(&obj); err != nil || obj == nil {
		return "", false
	}
	obj["ps"] = name
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(obj); err != nil {
		return "", false
	}
	return base64.StdEncoding.EncodeToString(bytes.TrimRight(buf.Bytes(), "\n")), true
}

// encodeURIComponent is JavaScript's: every UTF-8 byte percent-encoded but
// the letters, digits and `-_.!~*'()`.
func encodeURIComponent(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.IndexByte("-_.!~*'()", c) >= 0 {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}
