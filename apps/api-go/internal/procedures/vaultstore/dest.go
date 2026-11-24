package vaultstore

// The credential destination schemas every vault write validates against, and the
// redaction gate that decides whether a request may be answered by Go at all.
//
// Two parsers exist in TypeScript and both are reproduced here:
//
//   - the structural input schema (BotSecretDestinationInput / the destination of
//     VaultPutInput, bot-secrets.ts:730-745,811-822): Zod issues with paths, answered as a
//     BAD_REQUEST validation envelope;
//   - normalizeSecretDestination (bot-secrets.ts:331-346) over the full
//     botSecretDestinationSchema (bot-secrets.ts:191-249): a ClientError whose message is
//     the joined issues, answered as BAD_REQUEST with that message.
//
// The origin rules reuse the host classifier messageblocks ports from
// packages/contracts/src/clients/network-host.ts, so a metadata endpoint or a private
// address is judged by one implementation in this build.

import (
	"errors"
	"os"
	"regexp"
	"strings"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/messageblocks"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/agentsecrets"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/whatwgurl"
)

// Auth is BotSecretAuth: the method a credential is used with.
type Auth struct {
	Type     string
	Name     string // header
	Username string // basic
}

// Destination is a validated credential destination (BotSecretDestination).
type Destination struct {
	Name   string
	Origin string
	Auth   Auth
}

// Siteless is isSitelessAuth (bot-secrets.ts:52-54).
func Siteless(kind string) bool {
	return kind == "command" || kind == "card" || kind == "contact"
}

const (
	agentNamePattern     = `^[A-Z_][A-Z0-9_]{0,63}$`
	agentNameSource      = agentNamePattern
	botSecretNamePattern = `^[a-z][a-z0-9_-]{0,63}$`
	secretHeaderPattern  = "^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,120}$"
	basicUsernamePattern = `^[^:\r\n]+$`
)

var (
	agentNamePatternRegex = regexp.MustCompile(agentNamePattern)
	botSecretName         = regexp.MustCompile(botSecretNamePattern)
	secretHeader          = regexp.MustCompile(secretHeaderPattern)
	forbiddenHeader       = regexp.MustCompile(
		`(?i)^(host|connection|content-length|content-type|transfer-encoding|te|trailer|upgrade|cookie|origin|referer|accept|proxy-.*|sec-.*|.*forwarded.*)$`)
	basicUsername = regexp.MustCompile(basicUsernamePattern)
)

// Origin messages (bot-secrets.ts:162-186,236-241).
const (
	originMissingMessage = "Missing. Add the site's address, such as https://www.example.com"
	originHTTPMessage    = "Expected an HTTPS origin without a path, credentials, query, or fragment"
	originPrivateMessage = "Expected an HTTPS origin, or an HTTP origin on a private LAN host, " +
		"without a path, credentials, query, or fragment"
	loginHTTPSMessage = "Website logins require an HTTPS origin"
	unsupportedAccess = "This item can't be used that way"
)

// allowPrivateHTTPSecretOrigins is allowPrivateHttpSecretOrigins (bot-secrets.ts:327-329).
func allowPrivateHTTPSecretOrigins() bool {
	return os.Getenv("RAKAZO_SECRETS_ALLOW_PRIVATE_HTTP") == "1"
}

// regexIssue is zod's invalid_format for a regex check.
func regexIssue(path validate.Path, pattern, message string) validate.Issue {
	return validate.Issue{
		"origin": "string", "code": "invalid_format", "format": "regex",
		"pattern": pattern, "path": path.Raw(), "message": message,
	}
}

// regexMessage is zod's default message for a failed regex.
func regexMessage(pattern string) string {
	return "Invalid string: must match pattern /" + pattern + "/"
}

// customIssue is a failed .refine(): a pathful custom issue with the schema's message.
func customIssue(path validate.Path, message string) validate.Issue {
	return validate.Issue{"code": "custom", "path": path.Raw(), "message": message}
}

// invalidValueIssue is z.enum()'s invalid_value.
func invalidValueIssue(path validate.Path, values []string) validate.Issue {
	quoted := make([]string, len(values))
	for index, value := range values {
		quoted[index] = `"` + value + `"`
	}
	return validate.Issue{
		"code": "invalid_value", "values": values, "path": path.Raw(),
		"message": "Invalid option: expected one of " + strings.Join(quoted, "|"),
	}
}

// aborts is zod's continue:false switch: a later check does not run after these.
func aborts(issues []validate.Issue) bool {
	for _, issue := range issues {
		switch issue["code"] {
		case "invalid_type", "invalid_value", "invalid_union":
			return true
		}
	}
	return false
}

// parseAuth is BotSecretAuth (bot-secrets.ts:27-49), a discriminated union on `type`.
func parseAuth(raw any, path validate.Path) (Auth, []validate.Issue) {
	object, ok := raw.(*validate.Object)
	if !ok {
		return Auth{}, []validate.Issue{validate.TypeIssue("object", validate.JSType(raw), path)}
	}
	kind, isString := object.Values["type"].(string)
	known := false
	switch kind {
	case "bearer", "header", "basic", "login", "command", "card", "contact":
		known = isString
	}
	if !known {
		return Auth{}, []validate.Issue{{
			"code": "invalid_union", "errors": []any{}, "note": "No matching discriminator",
			"discriminator": "type",
			"options":       []string{"bearer", "header", "basic", "login", "command", "card", "contact"},
			"path":          path.With("type").Raw(),
			"message": "Invalid discriminator value. Expected 'bearer' | 'header' | 'basic' | " +
				"'login' | 'command' | 'card' | 'contact'",
		}}
	}
	auth := Auth{Type: kind}
	switch kind {
	case "header":
		name, problems := validate.String(path.With("name"), object.Field("name"), validate.StringRules{})
		if problems == nil && !secretHeader.MatchString(name) {
			problems = []validate.Issue{regexIssue(path.With("name"), secretHeaderPattern, regexMessage(secretHeaderPattern))}
		}
		if problems == nil && forbiddenHeader.MatchString(name) {
			problems = []validate.Issue{customIssue(path.With("name"), "Unsupported credential header")}
		}
		if problems != nil {
			return Auth{}, problems
		}
		auth.Name = name
	case "basic":
		username, problems := validate.String(path.With("username"), object.Field("username"),
			validate.StringRules{Min: 1, Max: 200})
		if problems == nil && !basicUsername.MatchString(username) {
			problems = []validate.Issue{regexIssue(path.With("username"), basicUsernamePattern, regexMessage(basicUsernamePattern))}
		}
		if problems != nil {
			// Both checks run: zod reports the length issue and the regex issue together.
			return Auth{}, problems
		}
		auth.Username = username
	}
	return auth, nil
}

// parseDestinationInput is the structural destination schema the input contract applies:
// name rules, an origin string, the auth union, and only the "a site is required" refine
// (bot-secrets.ts:730-745). The origin's own rules run later, in normalize.
func parseDestinationInput(raw any, path validate.Path, nameOptional bool) (Destination, bool, []validate.Issue) {
	object, ok := raw.(*validate.Object)
	if !ok {
		return Destination{}, false, []validate.Issue{validate.TypeIssue("object", validate.JSType(raw), path)}
	}
	var issues []validate.Issue
	destination := Destination{}
	_, hasName := object.Get("name")
	if nameOptional && !hasName {
		// VaultPutInput's destination may omit the name: the save makes one from the title.
	} else {
		name, problems := validate.String(path.With("name"), object.Field("name"), validate.StringRules{})
		if problems == nil && !botSecretName.MatchString(name) {
			problems = []validate.Issue{regexIssue(path.With("name"), botSecretNamePattern, regexMessage(botSecretNamePattern))}
		}
		issues = append(issues, problems...)
		destination.Name = name
	}
	if !aborts(issues) {
		// z.string().max(2048).default(""): absent is the empty string, not an issue.
		var origin string
		if _, present := object.Get("origin"); present {
			var problems []validate.Issue
			origin, problems = validate.String(path.With("origin"), object.Field("origin"),
				validate.StringRules{Max: 2048})
			issues = append(issues, problems...)
		}
		destination.Origin = origin
	}
	if !aborts(issues) {
		auth, problems := parseAuth(object.Field("auth"), path.With("auth"))
		issues = append(issues, problems...)
		destination.Auth = auth
	}
	if aborts(issues) {
		return Destination{}, false, issues
	}
	// .superRefine(requireSite): an origin-less destination must have no site.
	if destination.Origin == "" && !Siteless(destination.Auth.Type) {
		issues = append(issues, customIssue(path.With("origin"), "A site is required"))
	}
	if issues != nil {
		return Destination{}, false, issues
	}
	return destination, hasName, nil
}

// normalizeDestination is normalizeSecretDestination (bot-secrets.ts:331-346) over
// botSecretDestinationSchema: the message is the joined issue list, prefixed, exactly as the
// adapter refuses it. A refused value never names the value.
func normalizeDestination(destination Destination) (Destination, error) {
	issues := destinationIssues(destination)
	if len(issues) > 0 {
		detail := make([]string, len(issues))
		for index, issue := range issues {
			field, _ := issue["path"].([]any)
			label := "credential"
			if len(field) > 0 {
				parts := make([]string, len(field))
				for position, segment := range field {
					parts[position] = segmentLabel(segment)
				}
				label = strings.Join(parts, ".")
			}
			message, _ := issue["message"].(string)
			detail[index] = label + ": " + message
		}
		return Destination{}, badRequest("Invalid credential destination — " + strings.Join(detail, "; "))
	}
	if Siteless(destination.Auth.Type) {
		return destination, nil
	}
	parsed, err := whatwgurl.Parse(destination.Origin)
	if err != nil {
		// The schema's refine already accepted it, so this cannot happen; keep the error loud.
		return Destination{}, badRequest("Invalid credential destination — origin: " + originHTTPMessage)
	}
	destination.Origin = parsed.Origin()
	return destination, nil
}

func segmentLabel(segment any) string {
	switch typed := segment.(type) {
	case string:
		return typed
	case int:
		return itoa(typed)
	default:
		return ""
	}
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	var digits []byte
	for value > 0 {
		digits = append([]byte{byte('0' + value%10)}, digits...)
		value /= 10
	}
	return string(digits)
}

// destinationIssues is botSecretDestinationSchema (bot-secrets.ts:191-249) for a value that
// already passed the structural parse: the siteless and origin rules, in the schema's order.
func destinationIssues(destination Destination) []validate.Issue {
	originPath := validate.Path{"origin"}
	namePath := validate.Path{"name"}
	authPath := validate.Path{"auth"}
	var issues []validate.Issue
	name := destination.Name
	if name == "" || !botSecretName.MatchString(name) {
		issues = append(issues, regexIssue(namePath, botSecretNamePattern, regexMessage(botSecretNamePattern)))
	}
	auth := destination.Auth
	switch auth.Type {
	case "header":
		if auth.Name == "" || !secretHeader.MatchString(auth.Name) {
			issues = append(issues, regexIssue(authPath.With("name"), secretHeaderPattern, regexMessage(secretHeaderPattern)))
		} else if forbiddenHeader.MatchString(auth.Name) {
			issues = append(issues, customIssue(authPath.With("name"), "Unsupported credential header"))
		}
	case "basic":
		if auth.Username == "" || !basicUsername.MatchString(auth.Username) {
			issues = append(issues, regexIssue(authPath.With("username"), basicUsernamePattern, regexMessage(basicUsernamePattern)))
		}
	}
	if Siteless(auth.Type) {
		if destination.Origin != "" {
			label := auth.Type
			if label == "command" {
				label = "command variable"
			}
			issues = append(issues, customIssue(originPath, "A "+label+" has no site; leave origin empty"))
			return issues
		}
		if auth.Type != "command" {
			return issues
		}
		if problem, message := commandVariableIssue(name); problem != "" {
			issues = append(issues, customIssue(namePath, message))
		}
		return issues
	}
	if destination.Origin == "" {
		issues = append(issues, customIssue(originPath, originMissingMessage))
		return issues
	}
	if !validOrigin(destination.Origin, allowPrivateHTTPSecretOrigins()) {
		issues = append(issues, customIssue(originPath, originMessage(allowPrivateHTTPSecretOrigins())))
		return issues
	}
	if auth.Type != "login" {
		return issues
	}
	parsed, err := whatwgurl.Parse(destination.Origin)
	if err == nil && parsed.Protocol() == "https:" {
		return issues
	}
	issues = append(issues, customIssue(originPath, loginHTTPSMessage))
	return issues
}

// commandVariableIssue is commandVariableNameIssue (bot-secrets.ts:125-135): a reserved or
// unexportable variable name, with the message the schema carries.
func commandVariableIssue(name string) (string, string) {
	variable := agentsecrets.CommandVariableName(name)
	switch agentsecrets.CommandVariableProblem(variable) {
	case "reserved":
		return "reserved", "$" + variable + " is reserved and cannot be used as a command variable; choose another name"
	case "invalid":
		return "invalid", "$" + variable + " is not a valid environment variable name"
	}
	return "", ""
}

func originMessage(allowPrivate bool) string {
	if allowPrivate {
		return originPrivateMessage
	}
	return originHTTPMessage
}

// validOrigin is botSecretOriginSchema's refine (bot-secrets.ts:168-186): a URL with no
// non-empty userinfo, query, fragment or non-root path; HTTPS anywhere, HTTP only on the
// person's own network, and never a cloud metadata endpoint.
func validOrigin(value string, allowPrivate bool) bool {
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
	if messageblocks.IsCloudMetadataHost(parsed.Hostname()) {
		return false
	}
	switch parsed.Protocol() {
	case "https:":
		return true
	case "http:":
		return allowPrivate && messageblocks.IsPrivateNetworkHost(parsed.Hostname())
	default:
		return false
	}
}

// refused is a ClientError: a typed answer with its own code, status and message
// (packages/core ClientError, turned into an oRPC error by rpc-errors.ts:76-83).
type refused struct {
	code    string
	status  int
	message string
}

func (r *refused) Error() string { return r.message }

func badRequest(message string) error { return &refused{"BAD_REQUEST", 400, message} }

func conflict(message string) error { return &refused{"CONFLICT", 409, message} }

// asRefusal reports the oRPC error for a ClientError this package raised.
func asRefusal(err error) (*refused, bool) {
	var refusal *refused
	if errors.As(err, &refusal) {
		return refusal, true
	}
	return nil, false
}
