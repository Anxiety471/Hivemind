package modelretry

import (
	"encoding/json"
	"regexp"
	"strings"
	"time"
)

const openCodeSessionError = "OpenCode rejected this chat session. Send the message again."

// ownEndpointProviders are endpoints the user or operator runs and configures;
// a deployment-funded model never uses them.
var ownEndpointProviders = map[string]bool{
	"openai-compatible": true,
	"local":             true,
}

// Ranks are the worker's MODEL_FAILURE_RANK order, least to most severe.
const (
	rankTransient = iota
	rankOutput
	rankAccount
	rankServer
)

func rankToClass(rank int) Class {
	switch rank {
	case rankTransient:
		return ClassTransient
	case rankOutput:
		return ClassOutput
	case rankAccount:
		return ClassAccount
	default:
		return ClassServer
	}
}

// failureRank classifies one failure text. errorText and message are separate
// because the worker receives the provider's raw error and the (possibly
// fallback-envelope) message separately; callers here pass the same text.
func failureRank(errorText, message, provider string, failedAfterAccepting bool) int {
	classified := classifyRunError(message, time.Now())
	// Output diagnostics can quote generated text that looks like a timeout.
	if classified.kind == "output" {
		return rankOutput
	}
	// OpenCode drops chat sessions on its side; the next send opens a new one.
	if IsTransient(errorText) || message == openCodeSessionError {
		return rankTransient
	}
	// A refresh token the provider no longer accepts; the credential is already retired.
	if terminalOAuthRefreshErrorMarker(message) != "" {
		return rankAccount
	}
	if classified.kind != "" || classified.recovery != "" {
		return rankAccount
	}
	// The user's own endpoint refused a request its model or settings cannot take. On a
	// named provider the same rejection more likely means Rakazo built the request wrong.
	if classified.hasStatus &&
		(classified.status == 400 || classified.status == 422) &&
		ownEndpointProviders[provider] {
		return rankAccount
	}
	// The user's own endpoint took the request, then reported a failure of its own in the
	// reply with no status to place it: nothing Rakazo sent was refused, and another try
	// can succeed.
	if failedAfterAccepting && !classified.hasStatus && ownEndpointProviders[provider] {
		return rankTransient
	}
	return rankServer
}

// Unrecognized is a provider failure no rule places. Another try or another
// model may still succeed. Status is the HTTP status the provider answered
// with: it refused this exact request, so the same model is not asked again,
// but a backup may be.
type Unrecognized struct {
	Status    int
	HasStatus bool
}

// UnrecognizedFailure reports whether a provider failure is one no rule
// places: not transient, not unusable output, not the user's account, key or
// model, and nothing says the request was invalid or cancelled. The name
// differs from the worker's unrecognizedModelFailure only because Go cannot
// declare a type and a function with the same name, which the result type
// Unrecognized would otherwise require.
func UnrecognizedFailure(message, provider string) (Unrecognized, bool) {
	if NamesPermanentFailure(message) {
		return Unrecognized{}, false
	}
	if failureRank(message, message, provider, false) != rankServer {
		return Unrecognized{}, false
	}
	status, hasStatus := Status(message)
	if !hasStatus {
		classified := classifyRunError(message, time.Now())
		status, hasStatus = classified.status, classified.hasStatus
	}
	// Statuses that name the failure on their own: auth, payment, permission, a gone
	// model, size. They are not left unexplained.
	if hasStatus {
		switch status {
		case 401, 402, 403, 404, 410, 413:
			return Unrecognized{}, false
		}
	}
	return Unrecognized{Status: status, HasStatus: hasStatus}, true
}

type modelBackupOutcome struct {
	Provider string
	ModelID  string
	Status   string
	Reason   string
}

type modelFallbackFailure struct {
	PrimaryError string
	Backups      []modelBackupOutcome
}

// parseModelFallbackFailure reads a persisted fallback failure back into its
// parts; any other text reports false.
func parseModelFallbackFailure(details string) (modelFallbackFailure, bool) {
	var decoded any
	if err := json.Unmarshal([]byte(strings.TrimSpace(details)), &decoded); err != nil {
		return modelFallbackFailure{}, false
	}
	record := asRecord(decoded)
	version, ok := record["modelFallbackVersion"].(float64)
	if !ok || version != 1 {
		return modelFallbackFailure{}, false
	}
	primaryError, ok := record["primaryError"].(string)
	if !ok {
		return modelFallbackFailure{}, false
	}
	rawBackups, ok := record["backups"].([]any)
	if !ok || len(rawBackups) == 0 {
		return modelFallbackFailure{}, false
	}
	backups := make([]modelBackupOutcome, 0, len(rawBackups))
	for _, raw := range rawBackups {
		outcome := asRecord(raw)
		provider, providerOK := outcome["provider"].(string)
		modelID, modelOK := outcome["modelId"].(string)
		reason, reasonOK := outcome["reason"].(string)
		status, statusOK := outcome["status"].(string)
		if !providerOK || !modelOK || !reasonOK || !statusOK {
			return modelFallbackFailure{}, false
		}
		if status != "failed" && status != "skipped" {
			return modelFallbackFailure{}, false
		}
		backups = append(backups, modelBackupOutcome{
			Provider: provider,
			ModelID:  modelID,
			Status:   status,
			Reason:   reason,
		})
	}
	return modelFallbackFailure{PrimaryError: primaryError, Backups: backups}, true
}

var (
	terminalRefreshErrorMarkers = []string{
		"invalid_grant",
		"refresh_token_expired",
		"refresh_token_reused",
		"refresh_token_invalidated",
		// pi's Kimi Coding refresh reports a dead credential as this message without
		// embedding the OAuth marker text itself.
		"Kimi Code token refresh unauthorized",
	}

	refreshMarkerPatterns = compileRefreshMarkerPatterns()

	refreshHTTPStatusRE = regexp.MustCompile(`(?i)\bHTTP (\d{3})\b`)
	refreshStatusRE     = regexp.MustCompile(`(?i)\bstatus[= ](\d{3})\b`)
	refreshParensRE     = regexp.MustCompile(`\((\d{3})\)`)
	refreshFlatRE       = regexp.MustCompile(`^(\d{3})[\s:]`)
	refreshStatusCutRE  = regexp.MustCompile(`(\d{3}): `)
	refreshLeadingRE    = regexp.MustCompile(`^\d{3}[\s:]`)
)

func compileRefreshMarkerPatterns() []*regexp.Regexp {
	patterns := make([]*regexp.Regexp, 0, len(terminalRefreshErrorMarkers))
	for _, marker := range terminalRefreshErrorMarkers {
		// Word-ish boundaries keep invalid_grant from matching a longer token such as
		// not_invalid_grant, while still matching quoted JSON bodies.
		patterns = append(patterns, regexp.MustCompile(
			`(^|[^A-Za-z0-9_])`+regexp.QuoteMeta(marker)+`([^A-Za-z0-9_]|$)`,
		))
	}
	return patterns
}

// terminalOAuthRefreshErrorMarker returns the matched marker when a refresh
// failure permanently kills the stored credential, and the empty string for a
// transient failure that must not retire it. A marker retires only alongside a
// terminal 4xx, and a 5xx anywhere vetoes it, since a gateway failure can wrap
// a quoted marker without the token endpoint having judged the credential.
func terminalOAuthRefreshErrorMarker(message string) string {
	marker := ""
	for index, pattern := range refreshMarkerPatterns {
		if pattern.MatchString(message) {
			marker = terminalRefreshErrorMarkers[index]
			break
		}
	}
	header := refreshStatusHeader(message)
	terminalStatus := false
	serverErrorStatus := false
	consider := func(status int) {
		switch {
		case status == 400 || status == 401 || status == 403:
			terminalStatus = true
		case status >= 500 && status <= 599:
			serverErrorStatus = true
		}
	}
	for _, match := range refreshHTTPStatusRE.FindAllStringSubmatch(header, -1) {
		consider(atoiOrZero(match[1]))
	}
	for _, match := range refreshStatusRE.FindAllStringSubmatch(header, -1) {
		consider(atoiOrZero(match[1]))
	}
	for _, match := range refreshParensRE.FindAllStringSubmatch(header, -1) {
		consider(atoiOrZero(match[1]))
	}
	if match := refreshFlatRE.FindStringSubmatch(header); match != nil {
		consider(atoiOrZero(match[1]))
	}
	if marker != "" && terminalStatus && !serverErrorStatus {
		return marker
	}
	return ""
}

// refreshStatusHeader keeps only the layer's own status, before any quoted
// server payload. A mention like "status 502" inside a quoted body must not
// veto or grant terminality.
func refreshStatusHeader(message string) string {
	end := len(message)
	cutAt := func(index, keep int) {
		if index >= 0 && index+keep < end {
			end = index + keep
		}
	}
	cutAt(strings.Index(message, "): "), 1) // keep ")" so `(400)` still parses
	cutAt(strings.Index(message, ": {"), 1)
	cutAt(strings.Index(message, "body="), 0)
	cutAt(strings.Index(message, "stack="), 0)
	if flat := refreshStatusCutRE.FindStringSubmatchIndex(message); flat != nil {
		if flat[0] == 0 || message[flat[0]-1] != '(' {
			// Keep the 3 status digits so the flat header still parses.
			if flat[0]+3 < end {
				end = flat[0] + 3
			}
		}
	}
	if refreshLeadingRE.MatchString(message) {
		cutAt(strings.Index(message, ": "), 1)
	}
	return message[:end]
}

func atoiOrZero(text string) int {
	value := 0
	for _, digit := range text {
		value = value*10 + int(digit-'0')
	}
	return value
}
