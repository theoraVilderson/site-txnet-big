package sub

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

// The invariant this row turns on (F-113-f, catalog §7.5): Clash, Sing-box
// and Xray JSON are built from the same served lines as the base64 list, in
// the same order, one proxy per line the format can express. A line it cannot
// express is left out, never guessed at; and nothing left is still a valid
// config in the format asked for — an app handed an invalid body keeps
// nothing, which is what an empty body must not cause (F-609).

var (
	vmessJSON = `{"v":"2","ps":"DE vmess","add":"de.example.net","port":"8443","id":"22222222-2222-2222-2222-222222222222",` +
		`"aid":"0","scy":"auto","net":"ws","type":"none","host":"cdn.example.net","path":"/vm","tls":"tls","sni":"cdn.example.net"}`
	vlessReality = "vless://11111111-1111-1111-1111-111111111111@nl.example.net:443?type=tcp&security=reality" +
		"&sni=www.microsoft.com&fp=chrome&pbk=PUBKEY&sid=ab12&flow=xtls-rprx-vision#NL%20reality"
	vmessLine  = "vmess://" + base64.StdEncoding.EncodeToString([]byte(vmessJSON))
	trojanGRPC = "trojan://secret@tr.example.net:2083?type=grpc&serviceName=svc&security=tls&sni=tr.example.net&alpn=h2#TR"
	ssLine     = "ss://" + base64.RawURLEncoding.EncodeToString([]byte("chacha20-ietf-poly1305:sspass")) + "@ss.example.net:8388#SS"
	hy2Line    = "hysteria2://hypass@hy.example.net:443?sni=hy.example.net&obfs=salamander&obfs-password=ob#HY2"
	xhttpLine  = "vless://33333333-3333-3333-3333-333333333333@x.example.net:443?type=xhttp&path=/x&security=tls&sni=x.example.net#XH"
	// Formats no target here speaks: left out of every structured body.
	pluginSS  = "ss://" + base64.RawURLEncoding.EncodeToString([]byte("aes-128-gcm:p")) + "@p.example.net:1?plugin=v2ray-plugin#PL"
	wireguard = "wireguard://key@wg.example.net:51820#WG"
)

func TestEachSchemeIsReadIntoOneNode(t *testing.T) {
	cases := []struct {
		line string
		want node
	}{
		{vlessReality, node{Name: "NL reality", Type: "vless", Server: "nl.example.net", Port: 443,
			UUID: "11111111-1111-1111-1111-111111111111", Flow: "xtls-rprx-vision", Network: "tcp",
			Security: "reality", SNI: "www.microsoft.com", Fingerprint: "chrome", PublicKey: "PUBKEY", ShortID: "ab12"}},
		{vmessLine, node{Name: "DE vmess", Type: "vmess", Server: "de.example.net", Port: 8443,
			UUID: "22222222-2222-2222-2222-222222222222", Cipher: "auto", Network: "ws", Path: "/vm",
			Host: "cdn.example.net", Security: "tls", SNI: "cdn.example.net"}},
		{trojanGRPC, node{Name: "TR", Type: "trojan", Server: "tr.example.net", Port: 2083, Password: "secret",
			Network: "grpc", ServiceName: "svc", Security: "tls", SNI: "tr.example.net", ALPN: []string{"h2"}}},
		{ssLine, node{Name: "SS", Type: "shadowsocks", Server: "ss.example.net", Port: 8388,
			Cipher: "chacha20-ietf-poly1305", Password: "sspass", Network: "tcp"}},
		{hy2Line, node{Name: "HY2", Type: "hysteria2", Server: "hy.example.net", Port: 443, Password: "hypass",
			Security: "tls", SNI: "hy.example.net", Obfs: "salamander", ObfsPassword: "ob"}},
	}
	for _, tc := range cases {
		got, ok := parseLine(tc.line)
		if !ok {
			t.Errorf("%.30s: not read", tc.line)
			continue
		}
		gj, _ := json.Marshal(got)
		wj, _ := json.Marshal(tc.want)
		if string(gj) != string(wj) {
			t.Errorf("%.30s:\n got  %s\n want %s", tc.line, gj, wj)
		}
	}
	for _, line := range []string{pluginSS, wireguard, "vless://nohost", "not a link"} {
		if _, ok := parseLine(line); ok {
			t.Errorf("%q was read; a line no target speaks must be left out", line)
		}
	}
}

func served() []string {
	return []string{vlessReality, vmessLine, trojanGRPC, ssLine, hy2Line, xhttpLine, pluginSS, wireguard}
}

func TestClashIsEveryLineItCanExpressInOrder(t *testing.T) {
	body, ct := render(FormatClash, served())
	if ct != "text/yaml; charset=utf-8" {
		t.Fatalf("Content-Type = %q", ct)
	}
	var doc struct {
		Proxies     []map[string]any `yaml:"proxies"`
		ProxyGroups []struct {
			Name    string   `yaml:"name"`
			Proxies []string `yaml:"proxies"`
		} `yaml:"proxy-groups"`
		Rules []string `yaml:"rules"`
	}
	if err := yaml.Unmarshal(body, &doc); err != nil {
		t.Fatalf("body is not YAML: %v\n%s", err, body)
	}
	var names []string
	for _, p := range doc.Proxies {
		names = append(names, p["name"].(string))
	}
	// xhttp is not a Clash transport; the plugin ss and wireguard no format reads.
	want := "NL reality|DE vmess|TR|SS|HY2"
	if strings.Join(names, "|") != want {
		t.Fatalf("proxies = %q, want %s", names, want)
	}
	if doc.Proxies[0]["reality-opts"].(map[string]any)["public-key"] != "PUBKEY" {
		t.Errorf("vless reality proxy = %v", doc.Proxies[0])
	}
	if len(doc.ProxyGroups) == 0 || !strings.Contains(strings.Join(doc.ProxyGroups[0].Proxies, "|"), "HY2") {
		t.Errorf("the first group does not offer every proxy: %+v", doc.ProxyGroups)
	}
	if len(doc.Rules) == 0 || doc.Rules[len(doc.Rules)-1] != "MATCH,"+doc.ProxyGroups[0].Name {
		t.Errorf("rules = %q, want the last to send everything to the first group", doc.Rules)
	}
}

func TestSingBoxIsEveryLineItCanExpressInOrder(t *testing.T) {
	body, ct := render(FormatSingBox, served())
	if ct != "application/json; charset=utf-8" {
		t.Fatalf("Content-Type = %q", ct)
	}
	var doc struct {
		Outbounds []map[string]any `json:"outbounds"`
		Route     struct {
			Final string `json:"final"`
		} `json:"route"`
	}
	if err := json.Unmarshal(body, &doc); err != nil {
		t.Fatalf("body is not JSON: %v", err)
	}
	var proxies []string
	for _, o := range doc.Outbounds {
		switch o["type"] {
		case "selector", "urltest", "direct":
		default:
			proxies = append(proxies, o["tag"].(string))
		}
	}
	if want := "NL reality|DE vmess|TR|SS|HY2"; strings.Join(proxies, "|") != want {
		t.Fatalf("proxy outbounds = %q, want %s", proxies, want)
	}
	if doc.Route.Final != doc.Outbounds[0]["tag"] || doc.Outbounds[0]["type"] != "selector" {
		t.Errorf("route.final = %q, want the selector that comes first", doc.Route.Final)
	}
	reality := doc.Outbounds[2]["tls"].(map[string]any)["reality"].(map[string]any)
	if reality["public_key"] != "PUBKEY" || reality["short_id"] != "ab12" {
		t.Errorf("reality = %v", reality)
	}
}

func TestXrayIsOneFullConfigPerLineItCanExpress(t *testing.T) {
	body, ct := render(FormatXray, served())
	if ct != "application/json; charset=utf-8" {
		t.Fatalf("Content-Type = %q", ct)
	}
	var docs []struct {
		Remarks   string           `json:"remarks"`
		Outbounds []map[string]any `json:"outbounds"`
	}
	if err := json.Unmarshal(body, &docs); err != nil {
		t.Fatalf("body is not a JSON array: %v", err)
	}
	var names []string
	for _, d := range docs {
		names = append(names, d.Remarks)
		if d.Outbounds[0]["tag"] != "proxy" {
			t.Errorf("%s: the first outbound is %v, want the proxy", d.Remarks, d.Outbounds[0]["tag"])
		}
	}
	// Xray speaks xhttp; it has no hysteria2.
	if want := "NL reality|DE vmess|TR|SS|XH"; strings.Join(names, "|") != want {
		t.Fatalf("configs = %q, want %s", names, want)
	}
}

func TestTwoLinesWithOneNameStayTwoProxies(t *testing.T) {
	body, _ := render(FormatSingBox, []string{trojanGRPC, trojanGRPC})
	var doc struct {
		Outbounds []struct {
			Tag string `json:"tag"`
		} `json:"outbounds"`
	}
	_ = json.Unmarshal(body, &doc)
	seen := map[string]bool{}
	for _, o := range doc.Outbounds {
		if seen[o.Tag] {
			t.Fatalf("tag %q twice: a client app refuses the config", o.Tag)
		}
		seen[o.Tag] = true
	}
	if !seen["TR"] || !seen["TR 2"] {
		t.Fatalf("tags = %v, want TR and TR 2", seen)
	}
}

func TestNothingToServeIsAnEmptyValidConfigInEveryFormat(t *testing.T) {
	for _, lines := range [][]string{nil, {wireguard}} {
		body, _ := render(FormatClash, lines)
		var clash struct {
			Proxies []any    `yaml:"proxies"`
			Rules   []string `yaml:"rules"`
		}
		if err := yaml.Unmarshal(body, &clash); err != nil || len(clash.Proxies) != 0 || len(clash.Rules) == 0 {
			t.Errorf("clash %q: err=%v body=%s", lines, err, body)
		}
		body, _ = render(FormatSingBox, lines)
		var sb struct {
			Outbounds []map[string]any `json:"outbounds"`
		}
		if err := json.Unmarshal(body, &sb); err != nil || len(sb.Outbounds) != 1 || sb.Outbounds[0]["type"] != "direct" {
			t.Errorf("sing-box %q: err=%v body=%s", lines, err, body)
		}
		body, _ = render(FormatXray, lines)
		if string(body) != "[]" {
			t.Errorf("xray %q: body = %s, want []", lines, body)
		}
	}
}

func TestAnAskedFormatIsServedThroughTheHandler(t *testing.T) {
	store := storeWith(live("healthy", "u1", trojanGRPC))
	cases := map[string]string{
		"?format=clash": "text/yaml; charset=utf-8",
		"?format=xray":  "application/json; charset=utf-8",
		"":              "text/plain; charset=utf-8",
	}
	for query, want := range cases {
		res := get(t, store, "/sub/"+token+query, "")
		raw, _ := io.ReadAll(res.Body)
		if ct := res.Header.Get("Content-Type"); ct != want || !strings.Contains(string(raw)+decodeOrEmpty(raw), "tr.example.net") {
			t.Errorf("%q: Content-Type = %q, body %.60s", query, ct, raw)
		}
	}
}

func decodeOrEmpty(raw []byte) string {
	plain, _ := base64.StdEncoding.DecodeString(string(raw))
	return string(plain)
}
