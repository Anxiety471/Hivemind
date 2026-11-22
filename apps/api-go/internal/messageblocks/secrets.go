package messageblocks

import (
	"fmt"
	"regexp"
	"strings"
	"unicode/utf16"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/whatwgurl"
)

// This file ports the nested schemas MessageBlock leaves to TypeScript:
//
//   - `ask.credential` — botSecretDestinationSchema({allowPrivateHttpOrigin: true})
//     (packages/contracts/src/bots/bot-secrets.ts:191-249)
//   - `ask.oneTimeCode` — OneTimeCodeTarget
//     (packages/contracts/src/bots/bot-secrets.ts:256-257)
//   - the host classifiers both use
//     (packages/contracts/src/clients/network-host.ts:18-309)
//
// The host classifier is copied rather than approximated: the schema's accept/reject
// decision is exactly "https origin, no path/credentials/query/fragment, not a cloud
// metadata endpoint; private plain HTTP only when the caller allows it".

var (
	botSecretNamePattern = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,63}$`)
	agentSecretPattern   = regexp.MustCompile(`^[A-Z_][A-Z0-9_]{0,63}$`)
	secretHeaderPattern  = regexp.MustCompile("^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,120}$")
	forbiddenHeaders     = regexp.MustCompile(`(?i)^(host|connection|content-length|content-type|transfer-encoding|te|trailer|upgrade|cookie|origin|referer|accept|proxy-.*|sec-.*|.*forwarded.*)$`)
	basicUsernamePattern = regexp.MustCompile(`^[^:\r\n]+$`)
	ipv4Pattern          = regexp.MustCompile(`^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$`)
	ipv6PartPattern      = regexp.MustCompile(`^[0-9a-f]{1,4}$`)
	zonePattern          = regexp.MustCompile(`^[0-9a-z._~-]+$`)
)

func jsLength(value string) int { return len(utf16.Encode([]rune(value))) }

func strMaxJS(limit int) parser {
	return func(value any) (any, bool) {
		text, ok := value.(string)
		return text, ok && jsLength(text) <= limit
	}
}

func botSecretName(value any) (any, bool) {
	text, ok := value.(string)
	return text, ok && botSecretNamePattern.MatchString(text)
}

func secretHeaderName(value any) (any, bool) {
	text, ok := value.(string)
	return text, ok && secretHeaderPattern.MatchString(text) && !forbiddenHeaders.MatchString(text)
}

func basicUsername(value any) (any, bool) {
	text, ok := value.(string)
	return text, ok && jsLength(text) >= 1 && jsLength(text) <= 200 && basicUsernamePattern.MatchString(text)
}

// botSecretAuth is BotSecretAuth (bot-secrets.ts:25-53): a discriminated union on `type`.
func botSecretAuth(value any) (any, bool) {
	objectValue, ok := value.(map[string]any)
	if !ok {
		return nil, false
	}
	kind, _ := objectValue["type"].(string)
	switch kind {
	case "bearer", "login", "command", "card", "contact":
		return object(required("type", literal(kind)))(value)
	case "header":
		return object(required("type", literal("header")), required("name", secretHeaderName))(value)
	case "basic":
		return object(required("type", literal("basic")), required("username", basicUsername))(value)
	default:
		return nil, false
	}
}

// secretOrigin is botSecretOriginSchema (bot-secrets.ts:170-190).
func secretOrigin(allowPrivateHTTP bool) parser {
	return func(value any) (any, bool) {
		text, ok := value.(string)
		if !ok || jsLength(text) > 2048 {
			return nil, false
		}
		return text, validOrigin(text, allowPrivateHTTP)
	}
}

// validOrigin is botSecretOriginSchema's refine: a URL with no non-empty
// username/password, query, fragment or non-root path; HTTPS anywhere, HTTP
// only on the person's own network. It reads the same normalized components
// `new URL` exposes (bot-secrets.ts:162-190).
func validOrigin(value string, allowPrivateHTTP bool) bool {
	parsed, err := whatwgurl.Parse(value)
	if err != nil {
		return false
	}
	if parsed.Username() != "" || parsed.Password() != "" || parsed.Search() != "" || parsed.Hash() != "" {
		return false
	}
	if parsed.Pathname() != "/" {
		return false
	}
	if isCloudMetadataHost(parsed.Hostname()) {
		return false
	}
	switch parsed.Protocol() {
	case "https:":
		return true
	case "http:":
		return allowPrivateHTTP && isPrivateNetworkHost(parsed.Hostname())
	default:
		return false
	}
}

// normalizeSpecialURL is the part of the WHATWG URL parser that decides an origin
// string: strip tabs/newlines and surrounding C0 controls, then rewrite a special
// scheme's slash variants (`https:\host`, `https:/host`, `https:///host`) to `//`.

// normalizeURLPath is the URL parser's path state for an origin path: dot segments,
// including their percent-encoded spellings, collapse; empty segments do not.

// jsIPv4Host is the URL parser's IPv4 host handling: legacy octal/hex/short forms
// (`127.1`, `0177.0.0.1`, `0x7f.0.0.1`, `2130706433`) become dotted decimal. The
// boolean reports whether the last label made the host numeric; when it did, a
// parse failure is an invalid URL rather than a DNS name.

// credentialDestination is botSecretDestinationSchema({allowPrivateHttpOrigin: true})
// (bot-secrets.ts:191-249).
func credentialDestination(value any) (any, bool) {
	cleaned, ok := object(
		required("name", botSecretName),
		field{name: "origin", parse: strMaxJS(2048), def: "", hasDef: true},
		required("auth", botSecretAuth),
	)(value)
	if !ok {
		return nil, false
	}
	destination := cleaned.(map[string]any)
	auth := destination["auth"].(map[string]any)
	authType := auth["type"].(string)
	origin := destination["origin"].(string)
	if isSitelessAuth(authType) {
		if origin != "" {
			return nil, false
		}
		if authType == "command" && commandVariableProblem(commandVariableName(destination["name"].(string))) != "" {
			return nil, false
		}
		return destination, true
	}
	if origin == "" || !validOrigin(origin, true) {
		return nil, false
	}
	if authType == "login" {
		parsed, err := whatwgurl.Parse(origin)
		if err != nil || parsed.Protocol() != "https:" {
			return nil, false
		}
	}
	return destination, true
}

func isSitelessAuth(kind string) bool {
	return kind == "command" || kind == "card" || kind == "contact"
}

// oneTimeCodeTarget is OneTimeCodeTarget (bot-secrets.ts:256-257): an HTTPS origin
// only, with no private plain-HTTP allowance.
func oneTimeCodeTarget(value any) (any, bool) {
	return object(required("origin", secretOrigin(false)))(value)
}

var reservedCommandVariables = map[string]bool{
	"PATH": true, "HOME": true, "USER": true, "LOGNAME": true, "SHELL": true,
	"PWD": true, "OLDPWD": true, "TERM": true, "IFS": true, "ENV": true,
	"BASH_ENV": true, "BASHOPTS": true, "SHELLOPTS": true, "CDPATH": true,
	"GLOBIGNORE": true, "PROMPT_COMMAND": true, "PS4": true, "TMPDIR": true,
	"DISPLAY": true, "XAUTHORITY": true, "SSH_AUTH_SOCK": true, "NODE_OPTIONS": true,
	"NODE_PATH": true, "PYTHONPATH": true, "PYTHONHOME": true, "PYTHONSTARTUP": true,
	"PERL5LIB": true, "PERL5OPT": true, "RUBYOPT": true, "JAVA_TOOL_OPTIONS": true,
	"JDK_JAVA_OPTIONS": true, "HTTP_PROXY": true, "HTTPS_PROXY": true, "ALL_PROXY": true,
	"NO_PROXY": true, "SSL_CERT_FILE": true, "SSL_CERT_DIR": true, "SSLKEYLOGFILE": true,
	"REQUESTS_CA_BUNDLE": true, "CURL_CA_BUNDLE": true, "NODE_EXTRA_CA_CERTS": true,
	"NODE_TLS_REJECT_UNAUTHORIZED": true, "GIT_SSL_CAINFO": true, "GIT_SSL_NO_VERIFY": true,
	"OPENSSL_CONF": true, "OPENSSL_ENGINES": true, "OPENSSL_MODULES": true,
	"GIT_SSH": true, "GIT_SSH_COMMAND": true, "GIT_ASKPASS": true, "GIT_PROXY_COMMAND": true,
	"GIT_EXTERNAL_DIFF": true, "GIT_PAGER": true, "GIT_EDITOR": true, "GIT_EXEC_PATH": true,
	"GIT_TEMPLATE_DIR": true, "GCONV_PATH": true, "SSH_ASKPASS": true, "SSH_ASKPASS_REQUIRE": true,
}

var reservedCommandPrefixes = []string{"LD_", "DYLD_", "RAKAZO_", "GIT_CONFIG_", "NPM_CONFIG_"}

func commandVariableName(name string) string {
	return strings.ToUpper(strings.ReplaceAll(name, "-", "_"))
}

// commandVariableProblem is commandVariableProblem (bot-secrets.ts:147-156).
func commandVariableProblem(variable string) string {
	if !agentSecretPattern.MatchString(variable) {
		return "invalid"
	}
	if reservedCommandVariables[variable] {
		return "reserved"
	}
	for _, prefix := range reservedCommandPrefixes {
		if strings.HasPrefix(variable, prefix) {
			return "reserved"
		}
	}
	return ""
}

// ---- network-host.ts (packages/contracts/src/clients/network-host.ts) ----

var cloudMetadataIPv4 = map[uint32]bool{
	ipv4Value(169, 254, 169, 254): true,
	ipv4Value(169, 254, 170, 2):   true,
	ipv4Value(100, 100, 100, 200): true,
}

var cloudMetadataNames = map[string]bool{
	"metadata.google.internal": true,
	"metadata.goog":            true,
}

type ipv6 [8]uint16

func ipv4Value(a, b, c, d int) uint32 {
	return uint32(a)<<24 | uint32(b)<<16 | uint32(c)<<8 | uint32(d)
}

func canonicalHost(hostname string) string {
	host := strings.ToLower(hostname)
	host = strings.TrimPrefix(host, "[")
	host = strings.TrimSuffix(host, "]")
	return host
}

func normalizeHost(hostname string) string {
	return strings.TrimSuffix(canonicalHost(hostname), ".")
}

func parseIPv4(value string) (uint32, bool) {
	match := ipv4Pattern.FindStringSubmatch(value)
	if match == nil {
		return 0, false
	}
	var result uint32
	for _, octet := range match[1:] {
		if len(octet) > 1 && octet[0] == '0' {
			return 0, false
		}
		number := 0
		for _, digit := range octet {
			number = number*10 + int(digit-'0')
		}
		if number > 255 {
			return 0, false
		}
		result = result*256 + uint32(number)
	}
	return result, true
}

func parseIPv6(value string) (ipv6, bool) {
	var result ipv6
	if !strings.Contains(value, ":") {
		return result, false
	}
	address := value
	if zone := strings.Index(value, "%"); zone != -1 {
		address = value[:zone]
		if !zonePattern.MatchString(value[zone+1:]) {
			return result, false
		}
	}
	halves := strings.Split(address, "::")
	if len(halves) > 2 {
		return result, false
	}
	parts := make([][]string, len(halves))
	for index, half := range halves {
		if half != "" {
			parts[index] = strings.Split(half, ":")
		}
	}
	tail := parts[len(parts)-1]
	if len(tail) > 0 {
		last := tail[len(tail)-1]
		if strings.Contains(last, ".") {
			parsed, ok := parseIPv4(last)
			if !ok {
				return result, false
			}
			parts[len(parts)-1] = append(tail[:len(tail)-1], fmt.Sprintf("%x", parsed>>16), fmt.Sprintf("%x", parsed&0xffff))
		}
	}
	var groups []uint16
	for _, half := range parts {
		for _, part := range half {
			if !ipv6PartPattern.MatchString(part) {
				return result, false
			}
			var number uint16
			for _, digit := range part {
				number = number<<4 + uint16(hexValue(byte(digit)))
			}
			groups = append(groups, number)
		}
	}
	if len(halves) == 1 {
		if len(groups) != 8 {
			return result, false
		}
	} else {
		if len(groups) > 7 {
			return result, false
		}
		left := len(parts[0])
		filled := make([]uint16, 0, 8)
		filled = append(filled, groups[:left]...)
		for len(filled) < 8-len(groups)+left {
			filled = append(filled, 0)
		}
		filled = append(filled, groups[left:]...)
		groups = filled
	}
	copy(result[:], groups)
	return result, true
}

func hexValue(value byte) int {
	switch {
	case value >= '0' && value <= '9':
		return int(value - '0')
	case value >= 'a' && value <= 'f':
		return int(value-'a') + 10
	default:
		return -1
	}
}

func ipVersion(host string) int {
	value := canonicalHost(host)
	if _, ok := parseIPv4(value); ok {
		return 4
	}
	if _, ok := parseIPv6(value); ok {
		return 6
	}
	return 0
}

func ipv6UnspecifiedPrefix(value ipv6, groups int) bool {
	for index := range groups {
		if value[index] != 0 {
			return false
		}
	}
	return true
}

func ipv6Loopback(value ipv6) bool {
	return ipv6UnspecifiedPrefix(value, 7) && value[7] == 1
}

func ipv6LowIPv4(value ipv6) uint32 {
	return uint32(value[6])<<16 | uint32(value[7])
}

func ipv6MappedIPv4(value ipv6) (uint32, bool) {
	if ipv6UnspecifiedPrefix(value, 5) && value[5] == 0xffff {
		return ipv6LowIPv4(value), true
	}
	return 0, false
}

func ipv6EmbeddedIPv4(value ipv6) (uint32, bool) {
	if mapped, ok := ipv6MappedIPv4(value); ok {
		return mapped, true
	}
	if ipv6UnspecifiedPrefix(value, 6) {
		return ipv6LowIPv4(value), true
	}
	if value[0] == 0x64 && value[1] == 0xff9b &&
		value[2] == 0 && value[3] == 0 && value[4] == 0 && value[5] == 0 {
		return ipv6LowIPv4(value), true
	}
	if value[0] == 0x2002 {
		return uint32(value[1])<<16 | uint32(value[2]), true
	}
	return 0, false
}

func isCloudMetadataAddress(value string) bool {
	address := canonicalHost(value)
	if parsed, ok := parseIPv4(address); ok {
		return cloudMetadataIPv4[parsed]
	}
	parsed, ok := parseIPv6(address)
	if !ok {
		return false
	}
	if parsed == [8]uint16{0xfd00, 0x0ec2, 0, 0, 0, 0, 0, 0x0254} {
		return true
	}
	if embedded, ok := ipv6EmbeddedIPv4(parsed); ok {
		return cloudMetadataIPv4[embedded]
	}
	return false
}

func isCloudMetadataHost(hostname string) bool {
	host := normalizeHost(hostname)
	if cloudMetadataNames[host] {
		return true
	}
	return ipVersion(host) != 0 && isCloudMetadataAddress(host)
}

func inIPv4Ranges(value uint32, entries [][2]uint32) bool {
	for _, entry := range entries {
		if value&entry[1] == entry[0] {
			return true
		}
	}
	return false
}

func rangeMask(prefix int) uint32 {
	if prefix == 0 {
		return 0
	}
	return ^uint32(0) << (32 - prefix)
}

var privateNetworkIPv4 = [][2]uint32{
	{ipv4Value(10, 0, 0, 0), rangeMask(8)},
	{ipv4Value(100, 64, 0, 0), rangeMask(10)},
	{ipv4Value(127, 0, 0, 0), rangeMask(8)},
	{ipv4Value(172, 16, 0, 0), rangeMask(12)},
	{ipv4Value(192, 168, 0, 0), rangeMask(16)},
}

func isPrivateNetworkAddress(value string) bool {
	address := canonicalHost(value)
	if isCloudMetadataAddress(address) {
		return false
	}
	if parsed, ok := parseIPv4(address); ok {
		return inIPv4Ranges(parsed, privateNetworkIPv4)
	}
	parsed, ok := parseIPv6(address)
	if !ok {
		return false
	}
	return ipv6Loopback(parsed) || (parsed[0]&0xfe00) == 0xfc00
}

func isLoopbackHost(hostname string) bool {
	host := canonicalHost(hostname)
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return true
	}
	if parsed, ok := parseIPv4(host); ok {
		return parsed>>24 == 127
	}
	if parsed, ok := parseIPv6(host); ok {
		return ipv6Loopback(parsed)
	}
	return false
}

func isPrivateNetworkHost(hostname string) bool {
	host := canonicalHost(hostname)
	if isLoopbackHost(host) || strings.HasSuffix(host, ".local") {
		return true
	}
	return ipVersion(host) != 0 && isPrivateNetworkAddress(host)
}
