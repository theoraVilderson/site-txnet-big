package main

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"sync"
	"time"
)

type CertCache struct {
	mu    sync.Mutex
	certs map[string]*tls.Certificate
}

func NewCertCache() *CertCache {
	return &CertCache{certs: make(map[string]*tls.Certificate)}
}

func (cc *CertCache) GetCert(host string, ca *tls.Certificate) (tls.Certificate, error) {
	cc.mu.Lock()
	if c, ok := cc.certs[host]; ok {
		cc.mu.Unlock()
		return *c, nil
	}
	cc.mu.Unlock()

	caCert, err := x509.ParseCertificate(ca.Certificate[0])
	if err != nil {
		return tls.Certificate{}, err
	}

	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return tls.Certificate{}, err
	}

	template := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject: pkix.Name{
			CommonName: host,
		},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(365 * 24 * time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		DNSNames:              []string{host},
	}

	certDER, err := x509.CreateCertificate(rand.Reader, template, caCert, &priv.PublicKey, ca.PrivateKey)
	if err != nil {
		return tls.Certificate{}, err
	}

	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certDER})
	privPEM := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(priv)})

	cert, err := tls.X509KeyPair(certPEM, privPEM)
	if err != nil {
		return tls.Certificate{}, err
	}

	cc.mu.Lock()
	cc.certs[host] = &cert
	cc.mu.Unlock()

	return cert, nil
}

func generateCA() (tls.Certificate, []byte, []byte, error) {
	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return tls.Certificate{}, nil, nil, err
	}

	template := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject: pkix.Name{
			CommonName: "MITM Proxy CA",
		},
		NotBefore:             time.Now(),
		NotAfter:              time.Now().Add(10 * 365 * 24 * time.Hour),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
		IsCA:                  true,
		BasicConstraintsValid: true,
	}

	certDER, err := x509.CreateCertificate(rand.Reader, template, template, &priv.PublicKey, priv)
	if err != nil {
		return tls.Certificate{}, nil, nil, err
	}

	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certDER})
	privPEM := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(priv)})

	cert, err := tls.X509KeyPair(certPEM, privPEM)
	return cert, certPEM, privPEM, err
}