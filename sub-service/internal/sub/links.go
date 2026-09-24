package sub

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
)

// node is one stored link line read into the fields the structured formats
// (F-113-f, formats.go) are built from. The line itself stays the truth: the
// base64 list serves it untouched, and a line this file cannot read fully is
// left out of the other formats rather than guessed at.
type node struct {
	Name string
	// Type is the protocol: vless, vmess, trojan, shadowsocks, hysteria2, tuic.
	Type     string
	Server   string
	Port     int
	UUID     string
	Password string
	// Cipher is vmess's `scy` or shadowsocks' method.
	Cipher string
	Flow   string
	// Network is the transport: tcp, ws, grpc, h2, httpupgrade, xhttp. Empty
	// for the QUIC protocols, which have none.
	Network     string
	HeaderType  string
	Path        string
	Host        string
	ServiceName string
	Mode        string
	// Security is "", tls or reality.
	Security          string
	SNI               string
	ALPN              []string
	Fingerprint       string
	Insecure          bool
	PublicKey         string
	ShortID           string
	SpiderX           string
	Obfs              string
	ObfsPassword      string
	CongestionControl string
}

// parseLine reads one stored line. It refuses a scheme or a transport none of
// the formats speaks, a shadowsocks plugin (its options differ per plugin and
// per app), and a line with no server or port.
func parseLine(line string) (node, bool) {
	scheme, _, ok := strings.Cut(line, "://")
	if !ok {
		return node{}, false
	}
	var n node
	var err error
	switch strings.ToLower(scheme) {
	case "vless", "trojan":
		n, err = parseURLStyle(line)
	case "vmess":
		n, err = parseVmess(line)
	case "ss":
		n, err = parseShadowsocks(line)
	case "hysteria2", "hy2":
		n, err = parseQUIC(line, "hysteria2")
	case "tuic":
		n, err = parseQUIC(line, "tuic")
	default:
		return node{}, false
	}
	if err != nil || n.Server == "" || n.Port < 1 || n.Port > 65535 || !knownNetworks[n.Network] {
		return node{}, false
	}
	if n.Name == "" {
		n.Name = net.JoinHostPort(n.Server, strconv.Itoa(n.Port))
	}
	return n, true
}

// knownNetworks are the transports some format renders; "" is the QUIC
// protocols'. Which format renders which is decided in formats.go.
var knownNetworks = map[string]bool{
	"": true, "tcp": true, "ws": true, "grpc": true, "h2": true, "httpupgrade": true, "xhttp": true,
}

// normalNetwork maps the share-link spellings onto one name each.
func normalNetwork(s string) string {
	switch s = strings.ToLower(s); s {
	case "", "raw", "tcp":
		return "tcp"
	case "http", "h2":
		return "h2"
	case "splithttp":
		return "xhttp"
	}
	return s
}

func normalSecurity(s string) string {
	switch strings.ToLower(s) {
	case "tls", "xtls":
		return "tls"
	case "reality":
		return "reality"
	}
	return ""
}

func splitList(s string) []string {
	var out []string
	for _, a := range strings.Split(s, ",") {
		if a = strings.TrimSpace(a); a != "" {
			out = append(out, a)
		}
	}
	return out
}

func truthy(s string) bool { return s == "1" || strings.EqualFold(s, "true") }

func hostPort(u *url.URL) (string, int, error) {
	port, err := strconv.Atoi(u.Port())
	return u.Hostname(), port, err
}

// parseURLStyle reads vless:// and trojan://, which share one query grammar
// (the v2rayN / Xray share-link convention).
func parseURLStyle(line string) (node, error) {
	u, err := url.Parse(line)
	if err != nil || u.User == nil {
		return node{}, fmt.Errorf("no userinfo")
	}
	q := u.Query()
	n := node{Name: u.Fragment, Type: strings.ToLower(u.Scheme)}
	if n.Server, n.Port, err = hostPort(u); err != nil {
		return node{}, err
	}
	if n.Type == "vless" {
		n.UUID = u.User.Username()
		n.Flow = q.Get("flow")
	} else {
		n.Password = u.User.Username()
	}
	n.Network = normalNetwork(q.Get("type"))
	if n.HeaderType = q.Get("headerType"); n.HeaderType == "none" {
		n.HeaderType = ""
	}
	n.Path, n.Host = q.Get("path"), q.Get("host")
	n.ServiceName, n.Mode = q.Get("serviceName"), q.Get("mode")
	n.Security = normalSecurity(q.Get("security"))
	if n.Type == "trojan" && q.Get("security") == "" {
		n.Security = "tls" // a trojan link without `security` is TLS by definition
	}
	n.SNI, n.Fingerprint = q.Get("sni"), q.Get("fp")
	n.ALPN = splitList(q.Get("alpn"))
	n.Insecure = truthy(q.Get("allowInsecure")) || truthy(q.Get("insecure"))
	n.PublicKey, n.ShortID, n.SpiderX = q.Get("pbk"), q.Get("sid"), q.Get("spx")
	if n.Security == "reality" && n.PublicKey == "" {
		return node{}, fmt.Errorf("reality without a public key")
	}
	return n, nil
}

// decodeBase64 accepts any of the four encodings a panel may emit.
func decodeBase64(s string) ([]byte, error) {
	s = strings.TrimSpace(s)
	for _, enc := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding, base64.RawURLEncoding} {
		if b, err := enc.DecodeString(s); err == nil {
			return b, nil
		}
	}
	return nil, fmt.Errorf("not base64")
}

// field reads a vmess JSON value that panels write as a string or a number.
func field(m map[string]any, key string) string {
	switch v := m[key].(type) {
	case string:
		return v
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	}
	return ""
}

// parseVmess reads vmess://<base64 JSON>, the v2rayN format every panel emits.
func parseVmess(line string) (node, error) {
	raw, err := decodeBase64(strings.SplitN(line, "://", 2)[1])
	if err != nil {
		return node{}, err
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return node{}, err
	}
	n := node{Name: field(m, "ps"), Type: "vmess", Server: field(m, "add"), UUID: field(m, "id")}
	if n.Port, err = strconv.Atoi(field(m, "port")); err != nil {
		return node{}, err
	}
	if n.Cipher = field(m, "scy"); n.Cipher == "" {
		n.Cipher = "auto"
	}
	if aid := field(m, "aid"); aid != "" && aid != "0" {
		return node{}, fmt.Errorf("alterId %s: legacy vmess no current client speaks", aid)
	}
	n.Network = normalNetwork(field(m, "net"))
	if t := field(m, "type"); t != "none" {
		n.HeaderType = t
	}
	n.Path, n.Host = field(m, "path"), field(m, "host")
	if n.Network == "grpc" {
		n.ServiceName, n.Path = n.Path, ""
	}
	n.Security = normalSecurity(field(m, "tls"))
	n.SNI, n.Fingerprint = field(m, "sni"), field(m, "fp")
	n.ALPN = splitList(field(m, "alpn"))
	return n, nil
}

// parseShadowsocks reads both SIP002 (`ss://<b64 method:pass>@host:port`,
// or the userinfo percent-encoded) and the legacy `ss://<b64 of it all>`.
func parseShadowsocks(line string) (node, error) {
	rest := strings.SplitN(line, "://", 2)[1]
	var n node
	if i := strings.IndexByte(rest, '#'); i >= 0 {
		n.Name, _ = url.PathUnescape(rest[i+1:])
		rest = rest[:i]
	}
	if i := strings.IndexByte(rest, '?'); i >= 0 {
		q, _ := url.ParseQuery(rest[i+1:])
		if q.Get("plugin") != "" {
			return node{}, fmt.Errorf("plugin")
		}
		rest = rest[:i]
	}
	rest = strings.TrimSuffix(rest, "/")
	if !strings.Contains(rest, "@") {
		plain, err := decodeBase64(rest)
		if err != nil {
			return node{}, err
		}
		rest = string(plain)
	}
	at := strings.LastIndexByte(rest, '@')
	if at < 0 {
		return node{}, fmt.Errorf("no server")
	}
	user, hp := rest[:at], rest[at+1:]
	if plain, err := decodeBase64(user); err == nil && strings.Contains(string(plain), ":") {
		user = string(plain)
	} else if user, err = url.PathUnescape(user); err != nil {
		return node{}, err
	}
	var ok bool
	if n.Cipher, n.Password, ok = strings.Cut(user, ":"); !ok {
		return node{}, fmt.Errorf("no password")
	}
	host, port, err := net.SplitHostPort(hp)
	if err != nil {
		return node{}, err
	}
	n.Type, n.Server, n.Network = "shadowsocks", host, "tcp"
	n.Port, err = strconv.Atoi(port)
	return n, err
}

// parseQUIC reads hysteria2:// and tuic://; both are TLS over QUIC with no
// transport of their own.
func parseQUIC(line, typ string) (node, error) {
	u, err := url.Parse(line)
	if err != nil || u.User == nil {
		return node{}, fmt.Errorf("no userinfo")
	}
	q := u.Query()
	n := node{Name: u.Fragment, Type: typ, Security: "tls"}
	if n.Server, n.Port, err = hostPort(u); err != nil {
		return node{}, err
	}
	if typ == "tuic" {
		n.UUID = u.User.Username()
		n.Password, _ = u.User.Password()
		n.CongestionControl = q.Get("congestion_control")
	} else {
		n.Password = u.User.Username()
		if p, ok := u.User.Password(); ok { // `user:pass` auth is one password to the server
			n.Password += ":" + p
		}
		n.Obfs, n.ObfsPassword = q.Get("obfs"), q.Get("obfs-password")
	}
	n.SNI = q.Get("sni")
	n.ALPN = splitList(q.Get("alpn"))
	n.Insecure = truthy(q.Get("insecure")) || truthy(q.Get("allow_insecure")) || truthy(q.Get("allowInsecure"))
	return n, nil
}
