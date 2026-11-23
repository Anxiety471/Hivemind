package objectserver

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"
)

const (
	sigAlgorithm = "AWS4-HMAC-SHA256"
	maxClockSkew = 15 * time.Minute
)

// authenticate verifies an Authorization-header SigV4 signature made with the
// server's single access key. Query-string (presigned) requests are refused:
// nothing in the deployment issues them.
func (s *Server) authenticate(r *http.Request) error {
	auth := r.Header.Get("Authorization")
	rest, ok := strings.CutPrefix(auth, sigAlgorithm+" ")
	if !ok {
		return errAccessDenied
	}
	fields := map[string]string{}
	for _, part := range strings.Split(rest, ",") {
		k, v, found := strings.Cut(strings.TrimSpace(part), "=")
		if found {
			fields[k] = v
		}
	}
	credential, signedHeaders, signature := fields["Credential"], fields["SignedHeaders"], fields["Signature"]
	if credential == "" || signedHeaders == "" || signature == "" {
		return errAccessDenied
	}
	scopeParts := strings.Split(credential, "/")
	if len(scopeParts) != 5 || scopeParts[3] != "s3" || scopeParts[4] != "aws4_request" {
		return errAccessDenied
	}
	accessKey, shortDate, region := scopeParts[0], scopeParts[1], scopeParts[2]
	if subtle.ConstantTimeCompare([]byte(accessKey), []byte(s.cfg.AccessKeyID)) != 1 {
		return errInvalidKey
	}
	if region != s.cfg.Region {
		return errSignature
	}
	amzDate := r.Header.Get("X-Amz-Date")
	signedAt, err := time.Parse("20060102T150405Z", amzDate)
	if err != nil || amzDate[:8] != shortDate {
		return errAccessDenied
	}
	if skew := s.now().Sub(signedAt); skew > maxClockSkew || skew < -maxClockSkew {
		return errSkew
	}
	payloadHash := r.Header.Get("X-Amz-Content-Sha256")
	if payloadHash == "" {
		return errAccessDenied
	}

	names := strings.Split(signedHeaders, ";")
	if !sort.StringsAreSorted(names) {
		return errAccessDenied
	}
	var canonicalHeaders strings.Builder
	for _, name := range names {
		var value string
		if name == "host" {
			value = r.Host
		} else {
			value = strings.Join(r.Header.Values(name), ",")
		}
		canonicalHeaders.WriteString(name + ":" + strings.Join(strings.Fields(value), " ") + "\n")
	}
	canonicalRequest := strings.Join([]string{
		r.Method,
		rawPath(r),
		canonicalQuery(r),
		canonicalHeaders.String(),
		signedHeaders,
		payloadHash,
	}, "\n")
	scope := shortDate + "/" + region + "/s3/aws4_request"
	requestHash := sha256.Sum256([]byte(canonicalRequest))
	stringToSign := sigAlgorithm + "\n" + amzDate + "\n" + scope + "\n" + hex.EncodeToString(requestHash[:])
	key := hmacSHA256([]byte("AWS4"+s.cfg.SecretAccessKey), shortDate)
	key = hmacSHA256(key, region)
	key = hmacSHA256(key, "s3")
	key = hmacSHA256(key, "aws4_request")
	want := hex.EncodeToString(hmacSHA256(key, stringToSign))
	if subtle.ConstantTimeCompare([]byte(want), []byte(strings.ToLower(signature))) != 1 {
		return errSignature
	}
	return nil
}

// rawPath is the path exactly as the client sent it; S3 signs it single-encoded.
func rawPath(r *http.Request) string {
	uri := r.RequestURI
	if i := strings.IndexByte(uri, '?'); i >= 0 {
		uri = uri[:i]
	}
	if uri == "" {
		return "/"
	}
	return uri
}

func canonicalQuery(r *http.Request) string {
	q := r.URL.Query()
	keys := make([]string, 0, len(q))
	for k := range q {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var parts []string
	for _, k := range keys {
		vals := append([]string(nil), q[k]...)
		sort.Strings(vals)
		for _, v := range vals {
			parts = append(parts, awsEncode(k)+"="+awsEncode(v))
		}
	}
	return strings.Join(parts, "&")
}

func awsEncode(s string) string {
	var out strings.Builder
	for i := range len(s) {
		c := s[i]
		if (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~' {
			out.WriteByte(c)
		} else {
			fmt.Fprintf(&out, "%%%02X", c)
		}
	}
	return out.String()
}

func hmacSHA256(key []byte, data string) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(data))
	return mac.Sum(nil)
}
