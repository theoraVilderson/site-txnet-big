package driver

import (
	"encoding/base64"
	"strings"
	"testing"
)

// The expected lines are what x-ui's `inbound.js` gives for the same inbound
// and client (ADR-0088): `genVLESSLink`, `genVmessLink` and `genTrojanLink`
// under `genAllLinks` with the page's default `-ieo` remark model. The query
// is `URLSearchParams`' encoding and the remark `encodeURIComponent`'s.

const vlessClients = `{"clients":[{"id":"ID","email":"cfg_1"}],"decryption":"none"}`

func TestXrayLines(t *testing.T) {
	cases := []struct {
		name   string
		in     XrayInbound
		client XrayClient
		host   string
		want   []string
	}{
		{
			name: "vless over tcp with reality and a flow",
			in: XrayInbound{
				Remark: "DE", Port: 443, Protocol: "vless", Settings: vlessClients,
				StreamSettings: `{"network":"tcp","security":"reality","tcpSettings":{"header":{"type":"none"}},
					"realitySettings":{"serverNames":["www.speedtest.net","speedtest.net"],"shortIds":["6ba85179e30d4fc2","ab"],
					"privateKey":"never-shared","settings":{"publicKey":"PBK","fingerprint":"firefox","spiderX":"/"}}}`,
			},
			client: XrayClient{ID: "8a3c1e2b-0000-4000-8000-00000000abcd", Email: "cfg_1", Flow: "xtls-rprx-vision"},
			host:   "2.144.24.219",
			want: []string{"vless://8a3c1e2b-0000-4000-8000-00000000abcd@2.144.24.219:443?type=tcp&encryption=none" +
				"&security=reality&pbk=PBK&fp=firefox&sni=www.speedtest.net&sid=6ba85179e30d4fc2&spx=%2F&flow=xtls-rprx-vision#DE-cfg_1"},
		},
		{
			name: "vless over ws with tls: the Host header, the page's default alpn and fingerprint, no flow off tcp",
			in: XrayInbound{
				Listen: "node.example", Port: 8443, Protocol: "vless", Settings: vlessClients,
				StreamSettings: `{"network":"ws","security":"tls","tlsSettings":{"serverName":"cdn.example"},
					"wsSettings":{"path":"/ws","headers":{"Host":"h.example"}}}`,
			},
			client: XrayClient{ID: "ID", Email: "cfg_2", Flow: "xtls-rprx-vision"},
			host:   "2.144.24.219",
			want: []string{"vless://ID@node.example:8443?type=ws&encryption=none&path=%2Fws&host=h.example" +
				"&security=tls&fp=chrome&alpn=h3%2Ch2%2Chttp%2F1.1&sni=cdn.example#cfg_2"},
		},
		{
			name: "vless over tcp with an http header: the first path list and the first Host",
			in: XrayInbound{
				Listen: "0.0.0.0", Port: 80, Protocol: "vless", Settings: vlessClients,
				StreamSettings: `{"network":"tcp","security":"none","tcpSettings":{"header":{"type":"http",
					"request":{"path":["/a","/b"],"headers":{"Host":["h1.example","h2.example"]}}}}}`,
			},
			client: XrayClient{ID: "ID", Email: "cfg_6"},
			host:   "panel.example",
			want: []string{"vless://ID@panel.example:80?type=tcp&encryption=none&path=%2Fa%2C%2Fb&host=h1.example" +
				"&headerType=http&security=none#cfg_6"},
		},
		{
			name: "trojan over grpc with tls: an empty fingerprint is sent empty, allowInsecure as 1",
			in: XrayInbound{
				Remark: "T", Port: 2083, Protocol: "trojan", Settings: `{"clients":[]}`,
				StreamSettings: `{"network":"grpc","security":"tls","tlsSettings":{"serverName":"t.example","alpn":["h2"],
					"settings":{"allowInsecure":true,"fingerprint":""}},"grpcSettings":{"serviceName":"svc","multiMode":true}}`,
			},
			client: XrayClient{Password: "PW4", Email: "cfg_4"},
			host:   "panel.example",
			want: []string{"trojan://PW4@panel.example:2083?type=grpc&serviceName=svc&authority=&mode=multi" +
				"&security=tls&fp=&alpn=h2&allowInsecure=1&sni=t.example#T-cfg_4"},
		},
		{
			name: "an external proxy gives one line per entry, at its address, its remark last",
			in: XrayInbound{
				Remark: "E", Port: 443, Protocol: "vless", Settings: vlessClients,
				StreamSettings: `{"network":"tcp","security":"tls","tlsSettings":{"serverName":"a.example","alpn":[]},
					"externalProxy":[{"forceTls":"same","dest":"cdn1.example","port":443,"remark":"CDN"},
					{"forceTls":"none","dest":"1.2.3.4","port":80,"remark":""},
					{"forceTls":"same","dest":"cdn2.example","port":2053,"remark":"FP","sni":"s.example","utls":"safari","alpn":["h2"]}]}`,
			},
			client: XrayClient{ID: "ID5", Email: "cfg_5"},
			host:   "panel.example",
			want: []string{
				"vless://ID5@cdn1.example:443?type=tcp&encryption=none&security=tls&fp=chrome&alpn=&sni=a.example#E-cfg_5-CDN",
				"vless://ID5@1.2.3.4:80?type=tcp&encryption=none&security=none#E-cfg_5",
				"vless://ID5@cdn2.example:2053?type=tcp&encryption=none&security=tls&fp=safari&alpn=h2&sni=s.example#E-cfg_5-FP",
			},
		},
		{
			name: "an empty stream is tcp with no security, and a remark is encodeURIComponent's",
			in: XrayInbound{
				Remark: "آلمان 1", Port: 443, Protocol: "vless",
				Settings: `{"clients":[],"encryption":"mlkem768x25519plus.native.0rtt.KEY"}`, StreamSettings: "",
			},
			client: XrayClient{ID: "ID", Email: "c (x)!"},
			host:   "panel.example",
			want: []string{"vless://ID@panel.example:443?type=tcp&encryption=mlkem768x25519plus.native.0rtt.KEY" +
				"&security=none#%D8%A2%D9%84%D9%85%D8%A7%D9%86%201-c%20(x)!"},
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := XrayLines(c.in, c.client, c.host)
			if strings.Join(got, "\n") != strings.Join(c.want, "\n") {
				t.Errorf("XrayLines =\n  %s\nwant\n  %s", strings.Join(got, "\n  "), strings.Join(c.want, "\n  "))
			}
		})
	}
}

// A vmess line is base64 of the page's pretty-printed JSON, keys in its order.
func TestXrayLinesVmess(t *testing.T) {
	in := XrayInbound{
		Remark: "V", Port: 2052, Protocol: "vmess", Settings: `{"clients":[]}`,
		StreamSettings: `{"network":"ws","security":"none","wsSettings":{"path":"/","host":"v.example"}}`,
	}
	lines := XrayLines(in, XrayClient{ID: "ID3", Email: "cfg_3"}, "panel.example")
	if len(lines) != 1 || !strings.HasPrefix(lines[0], "vmess://") {
		t.Fatalf("XrayLines = %q, want one vmess line", lines)
	}
	body, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(lines[0], "vmess://"))
	if err != nil {
		t.Fatalf("the vmess body is not standard base64: %v", err)
	}
	want := `{
  "v": "2",
  "ps": "V-cfg_3",
  "add": "panel.example",
  "port": 2052,
  "id": "ID3",
  "scy": "auto",
  "net": "ws",
  "tls": "none",
  "path": "/",
  "host": "v.example"
}`
	if string(body) != want {
		t.Errorf("vmess JSON =\n%s\nwant\n%s", body, want)
	}

	tls := XrayInbound{
		Port: 443, Protocol: "vmess", Settings: `{"clients":[]}`,
		StreamSettings: `{"network":"grpc","security":"tls","tlsSettings":{"serverName":"g.example","alpn":["h2","http/1.1"],
			"settings":{"allowInsecure":true,"fingerprint":"chrome"}},"grpcSettings":{"serviceName":"svc","authority":"au"}}`,
	}
	lines = XrayLines(tls, XrayClient{ID: "ID", Email: "c", Security: "aes-128-gcm"}, "panel.example")
	if len(lines) != 1 {
		t.Fatalf("XrayLines = %q, want one vmess line", lines)
	}
	body, _ = base64.StdEncoding.DecodeString(strings.TrimPrefix(lines[0], "vmess://"))
	want = `{
  "v": "2",
  "ps": "c",
  "add": "panel.example",
  "port": 443,
  "id": "ID",
  "scy": "aes-128-gcm",
  "net": "grpc",
  "tls": "tls",
  "path": "svc",
  "authority": "au",
  "sni": "g.example",
  "fp": "chrome",
  "alpn": "h2,http/1.1",
  "allowInsecure": true
}`
	if string(body) != want {
		t.Errorf("vmess tls JSON =\n%s\nwant\n%s", body, want)
	}
}

// Rule 3: what the port does not cover builds nothing, never a guessed line.
func TestXrayLinesNeverGuess(t *testing.T) {
	cases := map[string]XrayInbound{
		"xhttp is not ported": {Port: 443, Protocol: "vless", Settings: vlessClients,
			StreamSettings: `{"network":"xhttp","security":"none","xhttpSettings":{"path":"/","mode":"auto"}}`},
		"reality with no public key cannot connect": {Port: 443, Protocol: "vless", Settings: vlessClients,
			StreamSettings: `{"network":"tcp","security":"reality","realitySettings":{"serverNames":["a"],"shortIds":["b"]}}`},
		"a protocol these drivers do not provision": {Port: 443, Protocol: "shadowsocks", Settings: `{"clients":[]}`,
			StreamSettings: `{"network":"tcp","security":"none"}`},
		"vmess has no reality": {Port: 443, Protocol: "vmess", Settings: `{"clients":[]}`,
			StreamSettings: `{"network":"tcp","security":"reality","realitySettings":{"settings":{"publicKey":"P"}}}`},
		"an old h2 network": {Port: 443, Protocol: "vless", Settings: vlessClients,
			StreamSettings: `{"network":"http","security":"tls"}`},
		"a stream that does not parse": {Port: 443, Protocol: "vless", Settings: vlessClients, StreamSettings: `{`},
		"no port": {Protocol: "vless", Settings: vlessClients, StreamSettings: `{}`},
	}
	for name, in := range cases {
		if got := XrayLines(in, XrayClient{ID: "ID", Password: "PW", Email: "c"}, "panel.example"); len(got) != 0 {
			t.Errorf("%s: XrayLines = %q, want none", name, got)
		}
	}
	if got := XrayLines(XrayInbound{Port: 443, Protocol: "vless", Settings: vlessClients, StreamSettings: `{}`},
		XrayClient{ID: "ID", Email: "c"}, ""); len(got) != 0 {
		t.Errorf("no address: XrayLines = %q, want none", got)
	}
	if got := XrayLines(XrayInbound{Port: 443, Protocol: "vless", Settings: vlessClients, StreamSettings: `{}`},
		XrayClient{Email: "c"}, "panel.example"); len(got) != 0 {
		t.Errorf("a client with no id: XrayLines = %q, want none", got)
	}
}
