package sub

import (
	"encoding/base64"
	"net/http"
	"strings"
)

// Config is a `network.config` row joined to its panel's state, as much of it
// as decides whether its stored lines reach the body.
type Config struct {
	// PanelID is what the render cache stamps a panel's changes under.
	PanelID       string
	PanelState    string
	Status        string
	DesiredRemote string
	UUID          string
	// LinksUUID is the client the lines were read from; empty when the config
	// was never captured (network contract.links.md rule 7).
	LinksUUID string
	LinkLines []string
	// UserLabel is the buyer's name for it, empty for the default; Region is
	// its panel's, the default name (F-307-h, ADR-0089).
	UserLabel string
	Region    string
	// Draining: the panel is a `drain` member of the Grant's panel group
	// (network contract.groups.md rule 13).
	Draining bool
}

// servingPanelStates are the `network.PanelState` values of a panel still
// serving its users. Every state is set from how the panel's *admin API*
// answered us (contract.budget.md): `degraded` answered in a shape we cannot
// act on and `throttled_or_blocked` refused us, and both are still working
// panels. `down` failed and `maintenance` was taken out by its owner. A state
// added later is left out until it is named here.
var servingPanelStates = map[string]bool{
	"healthy":              true,
	"degraded":             true,
	"throttled_or_blocked": true,
}

// serves reports whether a config's lines go into the body: a live config,
// on a serving panel, whose lines were captured from the client it is now.
// A regenerated uuid makes the old lines dead links, so they wait for the
// next capture rather than being served.
func serves(c Config) bool {
	return servingPanelStates[c.PanelState] &&
		c.Status == "active" && c.DesiredRemote == "present" &&
		c.LinksUUID != "" && c.LinksUUID == c.UUID
}

// servedLines is every line of every served config, configs in the store's
// order and each config's lines in the panel's, each named by
// lineNamesOfGrant over the whole Grant before anything is left out.
//
// A draining panel's lines are left out while the Grant has another served
// config (network contract.groups.md rule 13): the drain waits two
// subscription lifetimes from then before deleting the client, so no client
// still holds the line when it goes. A Grant whose only served lines are on
// draining panels keeps them — dropping them would cut the user off.
func servedLines(configs []Config, naming LineNaming) []string {
	replaced := false
	for _, c := range configs {
		if serves(c) && !c.Draining {
			replaced = true
			break
		}
	}
	names := lineNamesOfGrant(configs, naming)
	var lines []string
	for i, c := range configs {
		if serves(c) && !(replaced && c.Draining) {
			for j, line := range c.LinkLines {
				if name := names[i][j]; name != nil {
					line = nameLine(line, *name)
				}
				lines = append(lines, line)
			}
		}
	}
	return lines
}

// Format is a body a client app reads. The set is closed and declared here once.
type Format string

const (
	FormatBase64  Format = "base64"
	FormatClash   Format = "clash"
	FormatSingBox Format = "singbox"
	FormatXray    Format = "xray"
)

// formatNames are the `?format=` values, lowercase.
var formatNames = map[string]Format{
	"base64":   FormatBase64,
	"clash":    FormatClash,
	"singbox":  FormatSingBox,
	"sing-box": FormatSingBox,
	"xray":     FormatXray,
}

// userAgentFormats is matched in order against the lowercase `User-Agent`;
// the first substring found wins. An app not listed reads base64, which every
// client accepts.
var userAgentFormats = []struct {
	substring string
	format    Format
}{
	{"clash", FormatClash},
	{"mihomo", FormatClash},
	{"stash", FormatClash},
	{"sing-box", FormatSingBox},
	{"sfa/", FormatSingBox},
	{"sfi/", FormatSingBox},
	{"sfm/", FormatSingBox},
}

// DetectFormat is the format a request asks for: `?format=` when it names one
// (catalog C-08), else the `User-Agent`, else base64. A `?format=` naming
// nothing is ignored rather than refused — a client app handles a 4xx badly.
func DetectFormat(r *http.Request) Format {
	if f, ok := formatNames[strings.ToLower(r.URL.Query().Get("format"))]; ok {
		return f
	}
	ua := strings.ToLower(r.UserAgent())
	for _, m := range userAgentFormats {
		if strings.Contains(ua, m.substring) {
			return m.format
		}
	}
	return FormatBase64
}

// renderer turns the served lines into a body and its Content-Type.
type renderer func(lines []string) (body []byte, contentType string)

// renderers holds every format; the structured ones are formats.go (F-113-f).
// A format asked for and not here is answered with base64.
var renderers = map[Format]renderer{
	FormatBase64:  renderBase64,
	FormatClash:   renderClash,
	FormatSingBox: renderSingBox,
	FormatXray:    renderXray,
}

func render(f Format, lines []string) ([]byte, string) {
	if r, ok := renderers[f]; ok {
		return r(lines)
	}
	return renderBase64(lines)
}

// renderBase64 is the URI list, one line each, in standard padded base64.
// No lines is an empty body, which every client reads as a valid subscription
// with nothing in it.
func renderBase64(lines []string) ([]byte, string) {
	const contentType = "text/plain; charset=utf-8"
	if len(lines) == 0 {
		return nil, contentType
	}
	plain := strings.Join(lines, "\n")
	body := make([]byte, base64.StdEncoding.EncodedLen(len(plain)))
	base64.StdEncoding.Encode(body, []byte(plain))
	return body, contentType
}
