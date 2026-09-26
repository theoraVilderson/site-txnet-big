package driver

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

// An x-ui client's link lines, built here from what the inbound list already
// answered (ADR-0088): a port of x-ui's `inbound.js` — `genAllLinks` with the
// page's default `-ieo` remark model over `genVLESSLink`, `genVmessLink` and
// `genTrojanLink`. The page builds its lines in the browser from the same
// inbound JSON, so porting it is how a line of ours agrees with the panel's
// without reading its subscription server.
//
// Only what the port covers is built (ADR-0088 rule 3): vless, vmess and
// trojan, over tcp, kcp, ws, grpc and httpupgrade, with no security, TLS or
// REALITY. Anything else builds nothing, because a line that imports and
// never connects is worse than none.

// XrayInbound is an x-ui inbound as its list answers it. Settings and
// StreamSettings are the JSON strings x-ui stores.
type XrayInbound struct {
	Listen         string
	Port           int
	Protocol       string
	Remark         string
	Settings       string
	StreamSettings string
}

// XrayClient is one client of that inbound: the id (vless, vmess) or the
// password (trojan) it connects with.
type XrayClient struct {
	ID       string
	Password string
	Email    string
	Flow     string
	// Security is a vmess client's cipher; x-ui's page reads empty as `auto`.
	Security string
}

// XrayLines is every line x-ui's page would give this client, at host when
// the inbound listens on every address. Nil when the port does not cover the
// inbound, or there is no address, port or credential to put in a line.
func XrayLines(in XrayInbound, c XrayClient, host string) []string {
	s, ok := parseStream(in.StreamSettings)
	if !ok || in.Port <= 0 {
		return nil
	}
	switch s.Network {
	case "tcp", "kcp", "ws", "grpc", "httpupgrade":
	default:
		return nil
	}
	switch s.Security {
	case "none", "tls":
	case "reality":
		if in.Protocol == "vmess" || s.Reality.PublicKey == "" {
			return nil
		}
	default:
		return nil
	}
	switch in.Protocol {
	case "vless", "vmess":
		if c.ID == "" {
			return nil
		}
	case "trojan":
		if c.Password == "" {
			return nil
		}
	default:
		return nil
	}

	addr := host
	if in.Listen != "" && in.Listen != "0.0.0.0" {
		addr = in.Listen
	}
	proxies := s.ExternalProxy
	if len(proxies) == 0 {
		if addr == "" {
			return nil
		}
		proxies = []xrayProxy{{ForceTLS: "same", Dest: addr, Port: in.Port}}
	}
	var out []string
	for _, ep := range proxies {
		if ep.Dest == "" {
			continue
		}
		remark := joinNonEmpty("-", in.Remark, c.Email, ep.Remark)
		switch in.Protocol {
		case "vless":
			out = append(out, vlessLine(in, s, ep, remark, c))
		case "vmess":
			out = append(out, vmessLine(s, ep, remark, c))
		case "trojan":
			out = append(out, trojanLine(s, ep, remark, c))
		}
	}
	return out
}

func vlessLine(in XrayInbound, s xrayStream, ep xrayProxy, remark string, c XrayClient) string {
	encryption := "none"
	var settings struct {
		Encryption *string `json:"encryption"`
	}
	if json.Unmarshal([]byte(in.Settings), &settings) == nil && settings.Encryption != nil {
		encryption = *settings.Encryption
	}
	p := &params{}
	p.set("type", s.Network)
	p.set("encryption", encryption)
	s.transport(p)
	switch security := ep.security(s); security {
	case "tls":
		p.set("security", "tls")
		if s.Security == "tls" {
			p.set("fp", s.TLS.Fingerprint)
			p.set("alpn", strings.Join(s.TLS.ALPN, ","))
			if s.TLS.AllowInsecure {
				p.set("allowInsecure", "1")
			}
			setIf(p, "sni", s.TLS.ServerName)
			setIf(p, "ech", s.TLS.ECH)
			setIf(p, "pcs", strings.Join(s.TLS.Pinned, ","))
			setIf(p, "vcn", s.TLS.VerifyName)
			if s.Network == "tcp" {
				setIf(p, "flow", c.Flow)
			}
		}
	case "reality":
		s.reality(p)
		if s.Network == "tcp" {
			setIf(p, "flow", c.Flow)
		}
	default:
		p.set("security", "none")
	}
	ep.override(p, "allowInsecure", "1")
	return uriLine("vless", c.ID, ep, p, remark)
}

func trojanLine(s xrayStream, ep xrayProxy, remark string, c XrayClient) string {
	p := &params{}
	p.set("type", s.Network)
	s.transport(p)
	switch security := ep.security(s); security {
	case "tls":
		p.set("security", "tls")
		if s.Security == "tls" {
			p.set("fp", s.TLS.Fingerprint)
			p.set("alpn", strings.Join(s.TLS.ALPN, ","))
			if s.TLS.AllowInsecure {
				p.set("allowInsecure", "1")
			}
			setIf(p, "ech", s.TLS.ECH)
			setIf(p, "pcs", strings.Join(s.TLS.Pinned, ","))
			setIf(p, "vcn", s.TLS.VerifyName)
			setIf(p, "sni", s.TLS.ServerName)
		}
	case "reality":
		s.reality(p)
	default:
		p.set("security", "none")
	}
	ep.override(p, "allowInsecure", "1")
	return uriLine("trojan", c.Password, ep, p, remark)
}

// vmessLine is `vmess://` + base64 of the page's `JSON.stringify(obj, null, 2)`.
func vmessLine(s xrayStream, ep xrayProxy, remark string, c XrayClient) string {
	scy := c.Security
	if scy == "" {
		scy = "auto"
	}
	tls := ep.security(s)
	o := &params{}
	o.setAny("v", "2")
	o.setAny("ps", remark)
	o.setAny("add", ep.Dest)
	o.setAny("port", ep.Port)
	o.setAny("id", c.ID)
	o.setAny("scy", scy)
	o.setAny("net", s.Network)
	o.setAny("tls", tls)
	switch s.Network {
	case "tcp":
		o.setAny("type", s.TCP.Type)
		if s.TCP.Type == "http" {
			o.setAny("path", strings.Join(s.TCP.Paths, ","))
			if s.TCP.Host != "" {
				o.setAny("host", s.TCP.Host)
			}
		}
	case "ws", "httpupgrade":
		o.setAny("path", s.Path)
		o.setAny("host", s.Host)
	case "grpc":
		o.setAny("path", s.GRPC.ServiceName)
		o.setAny("authority", s.GRPC.Authority)
		if s.GRPC.MultiMode {
			o.setAny("type", "multi")
		}
	}
	if tls == "tls" {
		if s.TLS.ServerName != "" {
			o.setAny("sni", s.TLS.ServerName)
		}
		if s.TLS.Fingerprint != "" {
			o.setAny("fp", s.TLS.Fingerprint)
		}
		if len(s.TLS.ALPN) > 0 {
			o.setAny("alpn", strings.Join(s.TLS.ALPN, ","))
		}
		if s.TLS.AllowInsecure {
			o.setAny("allowInsecure", true)
		}
		if len(s.TLS.Pinned) > 0 {
			o.setAny("pcs", strings.Join(s.TLS.Pinned, ","))
		}
		if s.TLS.VerifyName != "" {
			o.setAny("vcn", s.TLS.VerifyName)
		}
	}
	ep.override(o, "allowInsecure", true)
	return "vmess://" + base64.StdEncoding.EncodeToString(o.prettyJSON())
}

// ---- the stream ------------------------------------------------------------

// xrayStream is `streamSettings` with the page's defaults applied, so every
// builder reads a value and never asks whether it was there.
type xrayStream struct {
	Network       string
	Security      string
	ExternalProxy []xrayProxy
	TLS           xrayTLS
	Reality       xrayReality
	TCP           struct {
		Type  string
		Paths []string
		Host  string
	}
	// Path and Host are ws's or httpupgrade's, whichever Network is.
	Path string
	Host string
	GRPC struct {
		ServiceName string `json:"serviceName"`
		Authority   string `json:"authority"`
		MultiMode   bool   `json:"multiMode"`
	}
}

type xrayTLS struct {
	ServerName    string
	ALPN          []string
	Fingerprint   string
	AllowInsecure bool
	ECH           string
	Pinned        []string
	VerifyName    string
}

type xrayReality struct {
	ServerName  string // the first of serverNames
	ShortID     string // the first of shortIds
	PublicKey   string
	Fingerprint string
	SpiderX     string
	PQV         string
}

type xrayProxy struct {
	ForceTLS      string
	Dest          string
	Port          int
	Remark        string
	SNI           string
	UTLS          string
	ALPN          []string
	AllowInsecure bool
	Fragment      *struct {
		Packets  string `json:"packets"`
		Length   string `json:"length"`
		Interval string `json:"interval"`
	}
}

func parseStream(raw string) (xrayStream, bool) {
	if strings.TrimSpace(raw) == "" {
		raw = "{}"
	}
	var w struct {
		Network       string            `json:"network"`
		Security      string            `json:"security"`
		ExternalProxy []json.RawMessage `json:"externalProxy"`
		TLSSettings   struct {
			ServerName string          `json:"serverName"`
			ALPN       *[]string       `json:"alpn"`
			Settings   json.RawMessage `json:"settings"`
		} `json:"tlsSettings"`
		RealitySettings struct {
			ServerNames json.RawMessage `json:"serverNames"`
			ShortIDs    json.RawMessage `json:"shortIds"`
			Settings    json.RawMessage `json:"settings"`
		} `json:"realitySettings"`
		TCPSettings struct {
			Header struct {
				Type    string `json:"type"`
				Request struct {
					Path    []string        `json:"path"`
					Headers json.RawMessage `json:"headers"`
				} `json:"request"`
			} `json:"header"`
		} `json:"tcpSettings"`
		WSSettings          pathHost `json:"wsSettings"`
		HTTPUpgradeSettings pathHost `json:"httpupgradeSettings"`
		GRPCSettings        struct {
			ServiceName string `json:"serviceName"`
			Authority   string `json:"authority"`
			MultiMode   bool   `json:"multiMode"`
		} `json:"grpcSettings"`
	}
	if err := json.Unmarshal([]byte(raw), &w); err != nil {
		return xrayStream{}, false
	}
	s := xrayStream{Network: or(w.Network, "tcp"), Security: or(w.Security, "none")}

	// TLS: the page's defaults are all three ALPNs and a chrome fingerprint.
	s.TLS.ServerName = w.TLSSettings.ServerName
	s.TLS.ALPN = []string{"h3", "h2", "http/1.1"}
	if w.TLSSettings.ALPN != nil {
		s.TLS.ALPN = *w.TLSSettings.ALPN
	}
	s.TLS.Fingerprint = "chrome"
	if !emptyObject(w.TLSSettings.Settings) {
		var ts struct {
			AllowInsecure bool            `json:"allowInsecure"`
			Fingerprint   *string         `json:"fingerprint"`
			ECH           string          `json:"echConfigList"`
			Pinned        json.RawMessage `json:"pinnedPeerCertSha256"`
			VerifyName    string          `json:"verifyPeerCertByName"`
		}
		if json.Unmarshal(w.TLSSettings.Settings, &ts) != nil {
			return xrayStream{}, false
		}
		if ts.Fingerprint != nil {
			s.TLS.Fingerprint = *ts.Fingerprint
		}
		s.TLS.AllowInsecure, s.TLS.ECH, s.TLS.VerifyName = ts.AllowInsecure, ts.ECH, ts.VerifyName
		s.TLS.Pinned = list(ts.Pinned)
	}

	// REALITY: serverNames defaults as the page's form does. A missing
	// shortIds is random in the page, so here it is none.
	names := list(w.RealitySettings.ServerNames)
	if w.RealitySettings.ServerNames == nil {
		names = []string{"microsoft.com", "www.microsoft.com"}
	}
	if len(names) > 0 {
		s.Reality.ServerName = names[0]
	}
	if ids := list(w.RealitySettings.ShortIDs); len(ids) > 0 {
		s.Reality.ShortID = ids[0]
	}
	s.Reality.Fingerprint, s.Reality.SpiderX = "chrome", "/"
	if !emptyObject(w.RealitySettings.Settings) {
		var rs struct {
			PublicKey   string  `json:"publicKey"`
			Fingerprint *string `json:"fingerprint"`
			SpiderX     *string `json:"spiderX"`
			PQV         string  `json:"mldsa65Verify"`
		}
		if json.Unmarshal(w.RealitySettings.Settings, &rs) != nil {
			return xrayStream{}, false
		}
		s.Reality.PublicKey, s.Reality.PQV = rs.PublicKey, rs.PQV
		if rs.Fingerprint != nil {
			s.Reality.Fingerprint = *rs.Fingerprint
		}
		if rs.SpiderX != nil {
			s.Reality.SpiderX = *rs.SpiderX
		}
	}

	s.TCP.Type = or(w.TCPSettings.Header.Type, "none")
	s.TCP.Paths = w.TCPSettings.Header.Request.Path
	if len(s.TCP.Paths) == 0 {
		s.TCP.Paths = []string{"/"}
	}
	s.TCP.Host = firstHeader(w.TCPSettings.Header.Request.Headers, "host")
	switch s.Network {
	case "ws":
		s.Path, s.Host = w.WSSettings.resolve()
	case "httpupgrade":
		s.Path, s.Host = w.HTTPUpgradeSettings.resolve()
	}
	s.GRPC = w.GRPCSettings

	for _, raw := range w.ExternalProxy {
		var ep struct {
			ForceTLS      string          `json:"forceTls"`
			Dest          string          `json:"dest"`
			Port          *int            `json:"port"`
			Remark        string          `json:"remark"`
			SNI           string          `json:"sni"`
			UTLS          string          `json:"utls"`
			ALPN          []string        `json:"alpn"`
			AllowInsecure json.RawMessage `json:"allowInsecure"`
			Fragment      json.RawMessage `json:"fragment"`
		}
		if json.Unmarshal(raw, &ep) != nil {
			return xrayStream{}, false
		}
		p := xrayProxy{
			ForceTLS: or(ep.ForceTLS, "same"), Dest: ep.Dest, Port: 443, Remark: ep.Remark,
			SNI: ep.SNI, UTLS: ep.UTLS, ALPN: ep.ALPN,
			// The page compares with the string 'true', so a boolean never matches.
			AllowInsecure: bytes.Equal(bytes.TrimSpace(ep.AllowInsecure), []byte(`"true"`)),
		}
		if ep.Port != nil {
			p.Port = *ep.Port
		}
		if len(ep.Fragment) > 0 && !bytes.Equal(bytes.TrimSpace(ep.Fragment), []byte("null")) {
			if json.Unmarshal(ep.Fragment, &p.Fragment) != nil {
				return xrayStream{}, false
			}
		}
		s.ExternalProxy = append(s.ExternalProxy, p)
	}
	return s, true
}

// pathHost is ws's and httpupgrade's settings: a path that defaults to `/`,
// and a host that falls back to the Host header.
type pathHost struct {
	Path    *string         `json:"path"`
	Host    string          `json:"host"`
	Headers json.RawMessage `json:"headers"`
}

func (ph pathHost) resolve() (string, string) {
	path := "/"
	if ph.Path != nil {
		path = *ph.Path
	}
	host := ph.Host
	if host == "" {
		host = firstHeader(ph.Headers, "host")
	}
	return path, host
}

// transport sets the network's own parameters, as the page's switch does.
func (s xrayStream) transport(p *params) {
	switch s.Network {
	case "tcp":
		if s.TCP.Type == "http" {
			p.set("path", strings.Join(s.TCP.Paths, ","))
			if s.TCP.Host != "" {
				p.set("host", s.TCP.Host)
			}
			p.set("headerType", "http")
		}
	case "ws", "httpupgrade":
		p.set("path", s.Path)
		p.set("host", s.Host)
	case "grpc":
		p.set("serviceName", s.GRPC.ServiceName)
		p.set("authority", s.GRPC.Authority)
		if s.GRPC.MultiMode {
			p.set("mode", "multi")
		}
	}
}

func (s xrayStream) reality(p *params) {
	p.set("security", "reality")
	p.set("pbk", s.Reality.PublicKey)
	p.set("fp", s.Reality.Fingerprint)
	setIf(p, "sni", s.Reality.ServerName)
	setIf(p, "sid", s.Reality.ShortID)
	setIf(p, "spx", s.Reality.SpiderX)
	setIf(p, "pqv", s.Reality.PQV)
}

// security is what the line says: the stream's, unless the proxy forces one.
func (ep xrayProxy) security(s xrayStream) string {
	if ep.ForceTLS == "same" {
		return s.Security
	}
	return ep.ForceTLS
}

// override applies the proxy's own TLS fields over the stream's, in place.
func (ep xrayProxy) override(p *params, insecureKey string, insecure any) {
	if ep.SNI != "" {
		p.setAny("sni", ep.SNI)
	}
	if len(ep.ALPN) > 0 {
		p.setAny("alpn", strings.Join(ep.ALPN, ","))
	}
	if ep.AllowInsecure {
		p.setAny(insecureKey, insecure)
	}
	if ep.UTLS != "" {
		p.setAny("fp", ep.UTLS)
	}
	if ep.Fragment != nil {
		p.setAny("packets", ep.Fragment.Packets)
		p.setAny("length", ep.Fragment.Length)
		p.setAny("interval", ep.Fragment.Interval)
	}
}

// ---- encoding --------------------------------------------------------------

// params is a JS Map: a key set again keeps its first position.
type params struct {
	keys []string
	vals map[string]any
}

func (p *params) setAny(k string, v any) {
	if p.vals == nil {
		p.vals = map[string]any{}
	}
	if _, ok := p.vals[k]; !ok {
		p.keys = append(p.keys, k)
	}
	p.vals[k] = v
}

func (p *params) set(k, v string) { p.setAny(k, v) }

func setIf(p *params, k, v string) {
	if v != "" {
		p.set(k, v)
	}
}

// query is `URLSearchParams.toString()`.
func (p *params) query() string {
	parts := make([]string, 0, len(p.keys))
	for _, k := range p.keys {
		parts = append(parts, formEncode(k)+"="+formEncode(fmt.Sprint(p.vals[k])))
	}
	return strings.Join(parts, "&")
}

// prettyJSON is `JSON.stringify(obj, null, 2)` over the keys in order.
func (p *params) prettyJSON() []byte {
	var b bytes.Buffer
	b.WriteString("{\n")
	for i, k := range p.keys {
		if i > 0 {
			b.WriteString(",\n")
		}
		b.WriteString("  ")
		b.Write(jsonValue(k))
		b.WriteString(": ")
		b.Write(jsonValue(p.vals[k]))
	}
	b.WriteString("\n}")
	return b.Bytes()
}

// jsonValue marshals as JSON.stringify does: no HTML escaping.
func jsonValue(v any) []byte {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
	return bytes.TrimRight(b.Bytes(), "\n")
}

func uriLine(scheme, user string, ep xrayProxy, p *params, remark string) string {
	addr := ep.Dest
	if strings.Contains(addr, ":") && !strings.HasPrefix(addr, "[") {
		addr = "[" + addr + "]"
	}
	return scheme + "://" + userinfoEncode(user) + "@" + addr + ":" + strconv.Itoa(ep.Port) +
		"?" + p.query() + "#" + uriComponent(remark)
}

// formEncode is the application/x-www-form-urlencoded byte serializer.
func formEncode(s string) string {
	return percent(s, func(c byte) bool { return alnum(c) || strings.IndexByte("*-._", c) >= 0 }, true)
}

// uriComponent is encodeURIComponent.
func uriComponent(s string) string {
	return percent(s, func(c byte) bool { return alnum(c) || strings.IndexByte("-_.!~*'()", c) >= 0 }, false)
}

// userinfoEncode is the URL standard's userinfo percent-encode set.
func userinfoEncode(s string) string {
	return percent(s, func(c byte) bool {
		return c > 0x20 && c < 0x7f && strings.IndexByte("\"#<>?`{}/:;=@[\\]^|", c) < 0
	}, false)
}

func percent(s string, keep func(byte) bool, spacePlus bool) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case keep(c):
			b.WriteByte(c)
		case c == ' ' && spacePlus:
			b.WriteByte('+')
		default:
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

func alnum(c byte) bool {
	return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9'
}

// ---- small readers ---------------------------------------------------------

// list reads a JSON array of strings or one comma-separated string, as the
// page accepts both for serverNames, shortIds and pinned hashes.
func list(raw json.RawMessage) []string {
	var arr []string
	if json.Unmarshal(raw, &arr) == nil {
		return nonEmpty(arr)
	}
	var one string
	if json.Unmarshal(raw, &one) == nil {
		return nonEmpty(strings.Split(one, ","))
	}
	return nil
}

func nonEmpty(in []string) []string {
	var out []string
	for _, s := range in {
		if s = strings.TrimSpace(s); s != "" {
			out = append(out, s)
		}
	}
	return out
}

// firstHeader is the page's getHeader: the first header of that name, any
// case, in the object's own order; a list value gives its first element.
func firstHeader(raw json.RawMessage, name string) string {
	dec := json.NewDecoder(bytes.NewReader(raw))
	if tok, err := dec.Token(); err != nil || tok != json.Delim('{') {
		return ""
	}
	for dec.More() {
		tok, err := dec.Token()
		if err != nil {
			return ""
		}
		key, _ := tok.(string)
		var v json.RawMessage
		if dec.Decode(&v) != nil {
			return ""
		}
		if !strings.EqualFold(key, name) {
			continue
		}
		if vals := list(v); len(vals) > 0 {
			return vals[0]
		}
	}
	return ""
}

func emptyObject(raw json.RawMessage) bool {
	t := bytes.TrimSpace(raw)
	if len(t) == 0 || bytes.Equal(t, []byte("null")) {
		return true
	}
	var m map[string]json.RawMessage
	return json.Unmarshal(t, &m) == nil && len(m) == 0
}

func or(v, fallback string) string {
	if v == "" {
		return fallback
	}
	return v
}

// joinNonEmpty is the page's remark: the non-empty parts, untrimmed.
func joinNonEmpty(sep string, parts ...string) string {
	var kept []string
	for _, s := range parts {
		if s != "" {
			kept = append(kept, s)
		}
	}
	return strings.Join(kept, sep)
}
