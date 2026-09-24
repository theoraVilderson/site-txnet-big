package sub

import (
	"encoding/json"
	"strconv"

	"gopkg.in/yaml.v3"
)

// The structured formats (F-113-f). Each is built from the same served lines
// as the base64 list, in the same order, one proxy per line the format can
// express; a line it cannot express is left out. With nothing left the body
// is still a valid config that proxies nothing, so an app keeps a working
// profile rather than an error (F-609's empty body, in this format).

const (
	contentTypeYAML = "text/yaml; charset=utf-8"
	contentTypeJSON = "application/json; charset=utf-8"
	// The groups every proxy is offered under; a proxy with one of these names
	// is renamed like any other duplicate.
	groupSelect = "Proxy"
	groupAuto   = "Auto"
	// probeURL is what the automatic group measures latency against.
	probeURL = "https://www.gstatic.com/generate_204"
)

// nodesFor reads every line and keeps those the format can express, each
// under a name no other proxy or group in the body has — an app refuses a
// config with two of one name.
func nodesFor(lines []string, supports func(node) bool) []node {
	taken := map[string]bool{groupSelect: true, groupAuto: true, "direct": true, "DIRECT": true}
	var out []node
	for _, l := range lines {
		n, ok := parseLine(l)
		if !ok || !supports(n) {
			continue
		}
		name := n.Name
		for i := 2; taken[name]; i++ {
			name = n.Name + " " + strconv.Itoa(i)
		}
		taken[name], n.Name = true, name
		out = append(out, n)
	}
	return out
}

func names(nodes []node) []string {
	out := make([]string, len(nodes))
	for i, n := range nodes {
		out[i] = n.Name
	}
	return out
}

// set writes a key only when it has a value, so an unset share-link
// parameter is the app's default rather than an empty one.
func set(m map[string]any, key string, v any) {
	switch x := v.(type) {
	case string:
		if x == "" {
			return
		}
	case bool:
		if !x {
			return
		}
	case []string:
		if len(x) == 0 {
			return
		}
	case map[string]any:
		if len(x) == 0 {
			return
		}
	}
	m[key] = v
}

// ---- Clash (mihomo) -------------------------------------------------------

func clashSupports(n node) bool {
	switch n.Network {
	case "xhttp":
		return false
	case "tcp":
		return n.HeaderType == "" || n.HeaderType == "http"
	}
	return true
}

type clashGroup struct {
	Name     string   `yaml:"name"`
	Type     string   `yaml:"type"`
	Proxies  []string `yaml:"proxies"`
	URL      string   `yaml:"url,omitempty"`
	Interval int      `yaml:"interval,omitempty"`
}

type clashConfig struct {
	MixedPort   int              `yaml:"mixed-port"`
	AllowLan    bool             `yaml:"allow-lan"`
	Mode        string           `yaml:"mode"`
	LogLevel    string           `yaml:"log-level"`
	Proxies     []map[string]any `yaml:"proxies"`
	ProxyGroups []clashGroup     `yaml:"proxy-groups"`
	Rules       []string         `yaml:"rules"`
}

func renderClash(lines []string) ([]byte, string) {
	nodes := nodesFor(lines, clashSupports)
	cfg := clashConfig{MixedPort: 7890, Mode: "rule", LogLevel: "warning",
		Proxies: []map[string]any{}, ProxyGroups: []clashGroup{}, Rules: []string{"MATCH,DIRECT"}}
	if len(nodes) > 0 {
		for _, n := range nodes {
			cfg.Proxies = append(cfg.Proxies, clashProxy(n))
		}
		cfg.ProxyGroups = []clashGroup{
			{Name: groupSelect, Type: "select", Proxies: append([]string{groupAuto}, names(nodes)...)},
			{Name: groupAuto, Type: "url-test", Proxies: names(nodes), URL: probeURL, Interval: 300},
		}
		cfg.Rules = []string{"MATCH," + groupSelect}
	}
	body, err := yaml.Marshal(cfg)
	if err != nil { // only maps of strings, numbers and bools: cannot happen
		panic(err)
	}
	return body, contentTypeYAML
}

func clashProxy(n node) map[string]any {
	p := map[string]any{"name": n.Name, "server": n.Server, "port": n.Port, "udp": true}
	switch n.Type {
	case "vless":
		p["type"], p["uuid"] = "vless", n.UUID
		set(p, "flow", n.Flow)
	case "vmess":
		p["type"], p["uuid"], p["alterId"], p["cipher"] = "vmess", n.UUID, 0, n.Cipher
	case "trojan":
		p["type"], p["password"] = "trojan", n.Password
	case "shadowsocks":
		p["type"], p["cipher"], p["password"] = "ss", n.Cipher, n.Password
	case "hysteria2":
		p["type"], p["password"] = "hysteria2", n.Password
		set(p, "obfs", n.Obfs)
		set(p, "obfs-password", n.ObfsPassword)
	case "tuic":
		p["type"], p["uuid"], p["password"] = "tuic", n.UUID, n.Password
		set(p, "congestion-controller", n.CongestionControl)
	}
	if n.Security != "" {
		// trojan, hysteria2 and tuic are always TLS and name the server `sni`.
		switch n.Type {
		case "vless", "vmess":
			p["tls"] = true
			set(p, "servername", n.SNI)
		default:
			set(p, "sni", n.SNI)
		}
		set(p, "alpn", n.ALPN)
		set(p, "skip-cert-verify", n.Insecure)
		set(p, "client-fingerprint", n.Fingerprint)
	}
	if n.Security == "reality" {
		p["reality-opts"] = map[string]any{"public-key": n.PublicKey, "short-id": n.ShortID}
		if n.Fingerprint == "" {
			p["client-fingerprint"] = "chrome" // reality needs one
		}
	}
	switch n.Network {
	case "tcp":
		if n.HeaderType == "http" { // Clash's `http` network is the HTTP/1.1 header on TCP
			p["network"] = "http"
			o := map[string]any{"path": []string{orSlash(n.Path)}}
			if n.Host != "" {
				o["headers"] = map[string]any{"Host": []string{n.Host}}
			}
			p["http-opts"] = o
		}
	case "ws", "httpupgrade":
		p["network"] = "ws"
		o := map[string]any{"path": orSlash(n.Path)}
		if n.Host != "" {
			o["headers"] = map[string]any{"Host": n.Host}
		}
		set(o, "v2ray-http-upgrade", n.Network == "httpupgrade")
		p["ws-opts"] = o
	case "grpc":
		p["network"] = "grpc"
		p["grpc-opts"] = map[string]any{"grpc-service-name": n.ServiceName}
	case "h2":
		p["network"] = "h2"
		o := map[string]any{"path": orSlash(n.Path)}
		set(o, "host", splitList(n.Host))
		p["h2-opts"] = o
	}
	return p
}

func orSlash(p string) string {
	if p == "" {
		return "/"
	}
	return p
}

// ---- Sing-box -------------------------------------------------------------

func singBoxSupports(n node) bool {
	if n.Network == "xhttp" {
		return false
	}
	return n.Network != "tcp" || n.HeaderType == ""
}

func renderSingBox(lines []string) ([]byte, string) {
	nodes := nodesFor(lines, singBoxSupports)
	direct := map[string]any{"type": "direct", "tag": "direct"}
	var cfg map[string]any
	if len(nodes) == 0 {
		// No inbound: the profile captures no traffic and proxies nothing.
		cfg = map[string]any{"log": map[string]any{"level": "warn"}, "outbounds": []any{direct}}
	} else {
		outbounds := []any{
			map[string]any{"type": "selector", "tag": groupSelect, "outbounds": append([]string{groupAuto}, names(nodes)...), "default": groupAuto},
			map[string]any{"type": "urltest", "tag": groupAuto, "outbounds": names(nodes), "url": probeURL, "interval": "5m"},
		}
		for _, n := range nodes {
			outbounds = append(outbounds, singBoxOutbound(n))
		}
		cfg = map[string]any{
			"log": map[string]any{"level": "warn"},
			"inbounds": []any{map[string]any{"type": "tun", "tag": "tun-in", "address": []string{"172.19.0.1/30"},
				"auto_route": true, "strict_route": true, "stack": "mixed"}},
			"outbounds": append(outbounds, direct),
			"route":     map[string]any{"auto_detect_interface": true, "final": groupSelect},
		}
	}
	return marshalJSON(cfg), contentTypeJSON
}

// singBoxOutbound is one proxy; its type names are sing-box's own.
func singBoxOutbound(n node) map[string]any {
	o := map[string]any{"type": n.Type, "tag": n.Name, "server": n.Server, "server_port": n.Port}
	switch n.Type {
	case "vless":
		o["uuid"] = n.UUID
		set(o, "flow", n.Flow)
	case "vmess":
		o["uuid"], o["security"], o["alter_id"] = n.UUID, n.Cipher, 0
	case "trojan", "hysteria2":
		o["password"] = n.Password
	case "shadowsocks":
		o["method"], o["password"] = n.Cipher, n.Password
	case "tuic":
		o["uuid"], o["password"] = n.UUID, n.Password
		set(o, "congestion_control", n.CongestionControl)
	}
	if n.Obfs != "" {
		o["obfs"] = map[string]any{"type": n.Obfs, "password": n.ObfsPassword}
	}
	if n.Security != "" {
		tls := map[string]any{"enabled": true}
		set(tls, "server_name", n.SNI)
		set(tls, "insecure", n.Insecure)
		set(tls, "alpn", n.ALPN)
		fp := n.Fingerprint
		if n.Security == "reality" {
			tls["reality"] = map[string]any{"enabled": true, "public_key": n.PublicKey, "short_id": n.ShortID}
			if fp == "" {
				fp = "chrome" // reality needs uTLS
			}
		}
		if fp != "" {
			tls["utls"] = map[string]any{"enabled": true, "fingerprint": fp}
		}
		o["tls"] = tls
	}
	switch n.Network {
	case "ws":
		t := map[string]any{"type": "ws", "path": orSlash(n.Path)}
		if n.Host != "" {
			t["headers"] = map[string]any{"Host": n.Host}
		}
		o["transport"] = t
	case "httpupgrade":
		t := map[string]any{"type": "httpupgrade", "path": orSlash(n.Path)}
		set(t, "host", n.Host)
		o["transport"] = t
	case "grpc":
		o["transport"] = map[string]any{"type": "grpc", "service_name": n.ServiceName}
	case "h2":
		t := map[string]any{"type": "http", "path": orSlash(n.Path)}
		set(t, "host", splitList(n.Host))
		o["transport"] = t
	}
	return o
}

// ---- Xray JSON ------------------------------------------------------------

// xraySupports: Xray has no hysteria2 or tuic outbound.
func xraySupports(n node) bool {
	switch n.Type {
	case "vless", "vmess", "trojan", "shadowsocks":
		return n.Network != "tcp" || n.HeaderType == "" || n.HeaderType == "http"
	}
	return false
}

// renderXray is the array of full client configs v2rayN and v2rayNG import,
// one per proxy, each named by `remarks`. Nothing to serve is `[]`.
func renderXray(lines []string) ([]byte, string) {
	configs := []any{}
	for _, n := range nodesFor(lines, xraySupports) {
		configs = append(configs, map[string]any{
			"remarks": n.Name,
			"log":     map[string]any{"loglevel": "warning"},
			"inbounds": []any{
				map[string]any{"tag": "socks", "protocol": "socks", "listen": "127.0.0.1", "port": 10808,
					"settings": map[string]any{"udp": true}},
				map[string]any{"tag": "http", "protocol": "http", "listen": "127.0.0.1", "port": 10809},
			},
			"outbounds": []any{
				xrayOutbound(n),
				map[string]any{"tag": "direct", "protocol": "freedom"},
				map[string]any{"tag": "block", "protocol": "blackhole"},
			},
		})
	}
	return marshalJSON(configs), contentTypeJSON
}

func xrayOutbound(n node) map[string]any {
	o := map[string]any{"tag": "proxy", "protocol": n.Type}
	switch n.Type {
	case "vless":
		user := map[string]any{"id": n.UUID, "encryption": "none"}
		set(user, "flow", n.Flow)
		o["settings"] = map[string]any{"vnext": []any{map[string]any{"address": n.Server, "port": n.Port, "users": []any{user}}}}
	case "vmess":
		user := map[string]any{"id": n.UUID, "alterId": 0, "security": n.Cipher}
		o["settings"] = map[string]any{"vnext": []any{map[string]any{"address": n.Server, "port": n.Port, "users": []any{user}}}}
	case "trojan":
		o["settings"] = map[string]any{"servers": []any{map[string]any{"address": n.Server, "port": n.Port, "password": n.Password}}}
	case "shadowsocks":
		o["settings"] = map[string]any{"servers": []any{map[string]any{"address": n.Server, "port": n.Port,
			"method": n.Cipher, "password": n.Password}}}
	}
	s := map[string]any{"network": n.Network, "security": "none"}
	switch n.Security {
	case "tls":
		s["security"] = "tls"
		t := map[string]any{}
		set(t, "serverName", n.SNI)
		set(t, "alpn", n.ALPN)
		set(t, "fingerprint", n.Fingerprint)
		set(t, "allowInsecure", n.Insecure)
		s["tlsSettings"] = t
	case "reality":
		s["security"] = "reality"
		fp := n.Fingerprint
		if fp == "" {
			fp = "chrome"
		}
		r := map[string]any{"publicKey": n.PublicKey, "fingerprint": fp}
		set(r, "serverName", n.SNI)
		set(r, "shortId", n.ShortID)
		set(r, "spiderX", n.SpiderX)
		s["realitySettings"] = r
	}
	switch n.Network {
	case "tcp":
		if n.HeaderType == "http" {
			req := map[string]any{"path": []string{orSlash(n.Path)}}
			if n.Host != "" {
				req["headers"] = map[string]any{"Host": splitList(n.Host)}
			}
			s["tcpSettings"] = map[string]any{"header": map[string]any{"type": "http", "request": req}}
		}
	case "ws":
		w := map[string]any{"path": orSlash(n.Path)}
		if n.Host != "" {
			w["headers"] = map[string]any{"Host": n.Host}
		}
		s["wsSettings"] = w
	case "grpc":
		s["grpcSettings"] = map[string]any{"serviceName": n.ServiceName}
	case "h2":
		h := map[string]any{"path": orSlash(n.Path)}
		set(h, "host", splitList(n.Host))
		s["httpSettings"] = h
	case "httpupgrade":
		h := map[string]any{"path": orSlash(n.Path)}
		set(h, "host", n.Host)
		s["httpupgradeSettings"] = h
	case "xhttp":
		x := map[string]any{"path": orSlash(n.Path)}
		set(x, "host", n.Host)
		set(x, "mode", n.Mode)
		s["xhttpSettings"] = x
	}
	o["streamSettings"] = s
	return o
}

// marshalJSON encodes maps, whose keys it sorts, so one set of lines always
// renders to one body.
func marshalJSON(v any) []byte {
	body, err := json.Marshal(v)
	if err != nil { // only maps of strings, numbers and bools: cannot happen
		panic(err)
	}
	return body
}
