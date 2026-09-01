package main

import (
	"crypto/tls"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

func main() {
	port := getEnv("LISTEN_PORT", "8080")
	bucket := os.Getenv("S3_BUCKET")

	caCert, certPEM, _, err := loadOrGenerateCA()
	if err != nil {
		log.Fatalf("CA setup failed: %v", err)
	}
	installCACert(certPEM)

	cache, err := NewS3Cache(bucket)
	if err != nil {
		log.Fatalf("S3 cache init: %v", err)
	}

	handler := &Proxy{
		ca:           caCert,
		cache:        cache,
		certs:        NewCertCache(),
		dedup:        NewDedup(),
		noCacheHosts: parseHostList(os.Getenv("NO_CACHE_HOSTS")),
		client:       buildOriginClient(),
	}

	log.Printf("MITM forward proxy listening on %s (S3 bucket: %s)", port, bucket)
	log.Fatal(http.ListenAndServe(":"+port, handler))
}

// buildOriginClient builds the single, shared http.Client used for every
// origin fetch (both cached and pass-through requests). If SOCKS_PROXY is
// set in the environment (e.g. via .env), all outbound origin requests are
// tunneled through that SOCKS5 proxy; otherwise they go out directly. This
// is decided once at startup rather than per-request so connections/idle
// pooling are actually reused.
func buildOriginClient() *http.Client {
	transport := &http.Transport{
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
	}

	if d := newSocks5DialerFromEnv(); d != nil {
		log.Printf("Outbound origin requests will be routed through SOCKS5 proxy %s", d.proxyAddr)
		transport.DialContext = d.DialContext
		// DialTLSContext is left nil on purpose: when it's nil, http.Transport
		// takes the net.Conn returned by DialContext (here, the tunnel
		// established through the SOCKS5 proxy) and performs the TLS
		// handshake itself using TLSClientConfig above. So HTTPS origin
		// requests still get proper TLS, just carried over the SOCKS tunnel.
	} else {
		log.Println("SOCKS_PROXY not set — outbound origin requests go direct")
	}

	return &http.Client{
		Timeout:   60 * time.Second,
		Transport: transport,
	}
}

func getEnv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

// parseHostList splits a comma-separated NO_CACHE_HOSTS value into a clean
// list, e.g. "registry.mycompany.local, .internal.mycompany.local"
func parseHostList(v string) []string {
	if v == "" {
		return nil
	}
	var out []string
	for _, h := range strings.Split(v, ",") {
		h = strings.TrimSpace(h)
		if h != "" {
			out = append(out, h)
		}
	}
	return out
}

func loadOrGenerateCA() (tls.Certificate, []byte, []byte, error) {
	certFile := os.Getenv("CA_CERT")
	keyFile := os.Getenv("CA_KEY")

	if certFile != "" && keyFile != "" {
		cert, err := tls.LoadX509KeyPair(certFile, keyFile)
		if err == nil {
			certPEM, _ := os.ReadFile(certFile)
			keyPEM, _ := os.ReadFile(keyFile)
			return cert, certPEM, keyPEM, nil
		}
		log.Printf("Could not load provided CA: %v, generating new one", err)
	}

	log.Println("Generating self-signed CA certificate...")
	cert, certPEM, keyPEM, err := generateCA()
	if err != nil {
		return tls.Certificate{}, nil, nil, err
	}

	if err := os.WriteFile("ca.crt", certPEM, 0644); err != nil {
		log.Printf("Warning: could not write ca.crt: %v", err)
	}
	if err := os.WriteFile("ca.key", keyPEM, 0600); err != nil {
		log.Printf("Warning: could not write ca.key: %v", err)
	}

	return cert, certPEM, keyPEM, nil
}