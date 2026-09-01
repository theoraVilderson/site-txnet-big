package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	neturl "net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// S3Cache implements CacheStorage against any S3-compatible object storage
// (AWS S3, ArvanCloud Object Storage, MinIO, etc.) using hand-rolled AWS
// Signature V4 (no external SDK dependency).
type S3Cache struct {
	bucket    string
	region    string
	accessKey string
	secretKey string

	// host is the storage host, e.g. "s3.ir-thr-at1.arvanstorage.ir" or
	// "s3.us-east-1.amazonaws.com". Never includes a scheme.
	host string

	// pathStyle selects "https://host/bucket/key" addressing instead of
	// the AWS-default virtual-hosted "https://bucket.host/key" addressing.
	// ArvanCloud and most MinIO-compatible providers expect path-style.
	pathStyle bool

	// client is a dedicated HTTP client with a generous timeout for
	// large object uploads/downloads.
	client *http.Client
}

// NewS3Cache builds an S3Cache from environment variables:
//
//	S3_BUCKET               (required) bucket/container name
//	AWS_REGION              (required) region string used for SigV4 signing
//	                        (ArvanCloud: e.g. "ir-thr-at1"; check your console)
//	AWS_ACCESS_KEY_ID       (required)
//	AWS_SECRET_ACCESS_KEY   (required)
//	S3_ENDPOINT             (optional) custom storage host, e.g.
//	                        "s3.ir-thr-at1.arvanstorage.ir" for ArvanCloud.
//	                        A scheme prefix (https://) is stripped if present.
//	                        Leave unset to use real AWS S3.
//	S3_FORCE_PATH_STYLE     (optional) "true"/"false". Defaults to true
//	                        whenever S3_ENDPOINT is set (ArvanCloud/MinIO
//	                        convention), false for real AWS S3.
func NewS3Cache(bucket string) (*S3Cache, error) {
	if bucket == "" {
		return nil, fmt.Errorf("S3_BUCKET is required")
	}
	region := os.Getenv("AWS_REGION")
	if region == "" {
		return nil, fmt.Errorf("AWS_REGION is required")
	}
	accessKey := os.Getenv("AWS_ACCESS_KEY_ID")
	secretKey := os.Getenv("AWS_SECRET_ACCESS_KEY")
	if accessKey == "" || secretKey == "" {
		return nil, fmt.Errorf("AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are required")
	}

	customEndpoint := os.Getenv("S3_ENDPOINT")
	host := fmt.Sprintf("s3.%s.amazonaws.com", region)
	pathStyle := false
	if customEndpoint != "" {
		host = strings.TrimPrefix(strings.TrimPrefix(customEndpoint, "https://"), "http://")
		host = strings.TrimSuffix(host, "/")
		pathStyle = true // sane default for ArvanCloud/MinIO
	}
	if v := os.Getenv("S3_FORCE_PATH_STYLE"); v != "" {
		parsed, err := strconv.ParseBool(v)
		if err != nil {
			return nil, fmt.Errorf("S3_FORCE_PATH_STYLE must be true/false: %w", err)
		}
		pathStyle = parsed
	}

	return &S3Cache{
		bucket:    bucket,
		region:    region,
		accessKey: accessKey,
		secretKey: secretKey,
		host:      host,
		pathStyle: pathStyle,
		client: &http.Client{
			Timeout: 10 * time.Minute,
		},
	}, nil
}

// objectURL returns the full request URL, the Host header value, and the
// SigV4 canonical URI for the given object key — these differ between
// path-style and virtual-hosted-style addressing.
func (s *S3Cache) objectURL(key string) (fullURL, host, canonicalURI string) {
	if s.pathStyle {
		host = s.host
		canonicalURI = "/" + s.bucket + "/" + key
	} else {
		host = s.bucket + "." + s.host
		canonicalURI = "/" + key
	}
	fullURL = "https://" + host + canonicalURI
	return
}

func (s *S3Cache) Get(ctx context.Context, key string) (http.Header, io.ReadCloser, bool, error) {
	url, host, canonicalURI := s.objectURL(key)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, nil, false, err
	}
	s.signRequest(req, host, canonicalURI)

	resp, err := s.client.Do(req)
	if err != nil {
		return nil, nil, false, err
	}

	if resp.StatusCode == http.StatusNotFound {
		resp.Body.Close()
		return nil, nil, false, nil // clean cache miss
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return nil, nil, false, fmt.Errorf("object storage GetObject %s: status %d", key, resp.StatusCode)
	}

	var headers http.Header
	if raw := resp.Header.Get("X-Amz-Meta-Http-Headers"); raw != "" {
		if err := json.Unmarshal([]byte(raw), &headers); err != nil {
			resp.Body.Close()
			return nil, nil, false, err
		}
	} else {
		headers = make(http.Header)
	}

	return headers, resp.Body, true, nil
}

func (s *S3Cache) Put(ctx context.Context, key string, headers http.Header, body io.Reader, originMethod, originURL string) error {
	headerJSON, err := json.Marshal(headers)
	if err != nil {
		return err
	}

	objURL, host, canonicalURI := s.objectURL(key)
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, objURL, body)
	if err != nil {
		return err
	}
	req.Header.Set("X-Amz-Meta-Http-Headers", string(headerJSON))

	// Store the original request info as dedicated object metadata so a
	// cached object can be identified by URL directly (e.g. in the S3/
	// ArvanCloud console) without having to parse X-Amz-Meta-Http-Headers.
	// Metadata values must be a single line (no CR/LF) — origin URLs are
	// already percent-encoded so this is just a defensive strip.
	req.Header.Set("X-Amz-Meta-Origin-Url", sanitizeMetaValue(originURL))
	req.Header.Set("X-Amz-Meta-Origin-Method", sanitizeMetaValue(originMethod))

	// Also set real S3 object tags (distinct from metadata) via
	// x-amz-tagging, so cached objects can be filtered/searched by tag in
	// the console or via GetObjectTagging/ListObjects-by-tag, not just by
	// opening each object's metadata individually. Tag values are capped
	// at 256 chars by S3, so long URLs are truncated — the full URL is
	// still available, untruncated, in X-Amz-Meta-Origin-Url above.
	req.Header.Set("X-Amz-Tagging", buildTaggingHeader(originMethod, originURL))

	// Unknown length up front (we're streaming the origin response as it
	// arrives) — Go's Transport falls back to chunked transfer encoding,
	// which S3-compatible storage accepts fine alongside UNSIGNED-PAYLOAD
	// signing.
	req.ContentLength = -1

	s.signRequest(req, host, canonicalURI)

	resp, err := s.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("object storage PutObject %s: status %d: %s", key, resp.StatusCode, respBody)
	}
	return nil
}

// sanitizeMetaValue strips characters that aren't valid in an HTTP header
// value (S3 user metadata is transported as plain headers).
func sanitizeMetaValue(v string) string {
	return strings.Map(func(r rune) rune {
		if r == '\r' || r == '\n' {
			return -1
		}
		return r
	}, v)
}

// maxTagValueLen is S3/ArvanCloud's per-tag-value limit.
const maxTagValueLen = 256

// buildTaggingHeader builds the value for x-amz-tagging: a URL
// query-string-encoded "key=value&key=value" list, as S3 tagging requires.
// The url tag is truncated to fit the 256-char limit; the untruncated URL
// still lives in X-Amz-Meta-Origin-Url.
func buildTaggingHeader(method, originURL string) string {
	if len(originURL) > maxTagValueLen {
		originURL = originURL[:maxTagValueLen]
	}
	values := neturl.Values{}
	values.Set("origin-method", method)
	values.Set("origin-url", originURL)
	return values.Encode()
}

func (s *S3Cache) signRequest(req *http.Request, host, canonicalURI string) {
	now := time.Now().UTC()
	date := now.Format("20060102T150405Z")
	shortDate := now.Format("20060102")

	req.Host = host
	req.Header.Set("Host", host)
	req.Header.Set("X-Amz-Date", date)
	req.Header.Set("X-Amz-Content-Sha256", "UNSIGNED-PAYLOAD")

	canonicalQueryString := ""
	canonicalHeaders := fmt.Sprintf("host:%s\nx-amz-content-sha256:UNSIGNED-PAYLOAD\nx-amz-date:%s\n", host, date)
	signedHeaders := "host;x-amz-content-sha256;x-amz-date"
	payloadHash := "UNSIGNED-PAYLOAD"

	canonicalRequest := fmt.Sprintf("%s\n%s\n%s\n%s\n%s\n%s",
		req.Method, canonicalURI, canonicalQueryString, canonicalHeaders, signedHeaders, payloadHash)

	algorithm := "AWS4-HMAC-SHA256"
	credentialScope := fmt.Sprintf("%s/%s/s3/aws4_request", shortDate, s.region)
	stringToSign := fmt.Sprintf("%s\n%s\n%s\n%s",
		algorithm, date, credentialScope, hashString(canonicalRequest))

	signingKey := getSignatureKey(s.secretKey, shortDate, s.region, "s3")
	signature := hex.EncodeToString(hmacSHA256(signingKey, stringToSign))

	authorization := fmt.Sprintf("%s Credential=%s/%s, SignedHeaders=%s, Signature=%s",
		algorithm, s.accessKey, credentialScope, signedHeaders, signature)
	req.Header.Set("Authorization", authorization)
}

func getSignatureKey(secret, date, region, service string) []byte {
	kDate := hmacSHA256([]byte("AWS4"+secret), date)
	kRegion := hmacSHA256(kDate, region)
	kService := hmacSHA256(kRegion, service)
	kSigning := hmacSHA256(kService, "aws4_request")
	return kSigning
}

func hmacSHA256(key []byte, data string) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(data))
	return mac.Sum(nil)
}

func hashString(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}