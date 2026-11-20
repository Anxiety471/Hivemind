package modelretry

import (
	"encoding/json"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// Fixed failure strings the run error view knows by value. A run loop that
// produces one of these gets the same recovery advice in Go as in the worker.
const (
	// ModelOutputLimitError is the model's reply ending before it wrote anything.
	ModelOutputLimitError = "The model hit its output limit before writing a response."
	// ModelOutputCutError is the model's reply cut at its output limit partway through.
	ModelOutputCutError = "The model hit its output limit before finishing its reply."
	// ModelContextTooSmallError is the bot's instructions and tools not fitting the model.
	ModelContextTooSmallError = "This model's context window is too small. Choose another model."
	// ModelRequestLimitError is the provider account's request budget not fitting the bot.
	ModelRequestLimitError = "This connection's request limit is too small. Choose another model."
	// VerbatimToolResultTooLargeError is one whole tool result still not fitting the model.
	VerbatimToolResultTooLargeError = "This server's tool result does not fit the model. Turn off Keep tool results whole for that server, or choose another model."
	// MissingToolFinalResponseError is tools finishing without a final answer.
	MissingToolFinalResponseError = "The tools finished, but the model did not write a final answer. Rephrase the request and try again."
	// ApprovedActionNotRunError is a resumed run not calling the approved action.
	ApprovedActionNotRunError = "The model did not run the approved action. Try again."
	// MissingModelRunError is a run with no model connected.
	MissingModelRunError = "Connect a model in Settings before running bots."
	// HostedModelCreditsRequiredError is a deployment run without credits chosen.
	HostedModelCreditsRequiredError = "Connect your own API key in Models or choose Rakazo credits in Billing."
	// ModelCreditsExhaustedError is a metered call the organization's credits cannot cover.
	ModelCreditsExhaustedError = "Not enough model credits. Add credits in Billing or connect your own API key."
	// ModelUnpricedForCreditsError is a model Rakazo credits cannot price.
	ModelUnpricedForCreditsError = "This model has no reliable price. Connect your own API key to use it."
	// ModelCreditCapReachedError is an operator-set usage ceiling.
	ModelCreditCapReachedError = "Usage limit reached. Contact support to continue."
	// ModelAccessRequiredRunError is a billing organization without a paid plan.
	ModelAccessRequiredRunError = "Subscribe in Billing to keep running bots."
	// ModelImageInputError is a model that cannot read images.
	ModelImageInputError = "This model cannot read images. Choose a model that supports images."
	// ModelImageInputUnknown is image input not configured for a model.
	ModelImageInputUnknown = "Image input is not configured for this model."
	// ComputerRateLimitError is the computer provider's own rate limit.
	ComputerRateLimitError = "Too many computer requests. Try again later."
	// ComputerAllowanceUsedError is this period's computer hours being spent.
	ComputerAllowanceUsedError = "No computer hours left."
	// ComputerProviderUnavailableError is the deployment's computer account unable to start.
	ComputerProviderUnavailableError = "Computers are unavailable right now. Try again later."
	// ComputerUnresponsiveError is a running computer not answering.
	ComputerUnresponsiveError = "The computer stopped responding. Try again."
	// StuckWorkQueuedMessage is a queued wait cancelled without starting.
	StuckWorkQueuedMessage = "Stopped. This stayed queued without starting."
	// StuckWorkWaitingInputMessage is a question wait cancelled without an answer.
	StuckWorkWaitingInputMessage = "Stopped. This was still waiting for an answer."
	// StuckWorkWaitingTakeoverMessage is a takeover wait cancelled without action.
	StuckWorkWaitingTakeoverMessage = "Stopped. This was still waiting for you on the screen."
)

// internalRunError is what the API answers for an unexpected failure.
const internalRunError = "Internal server error"

// IsComputerAllowanceUsed reports whether the message is the spent computer
// allowance, which only a plan change fixes. Persisted messages can carry
// detail after the fixed wording, so this checks the prefix.
func IsComputerAllowanceUsed(message string) bool {
	return strings.HasPrefix(message, ComputerAllowanceUsedError)
}

// placement is the part of the worker's normalizeRunError result that decides
// how a failure is retried and which recovery the user is offered.
type placement struct {
	kind      string
	recovery  string
	status    int
	hasStatus bool
}

// classifyRunError ports the branches of normalizeRunError that decide kind,
// recovery and status. Summaries, translation, locale formatting and the
// resetAt date text are the reporting layer's concern, not the retry rules'.
func classifyRunError(details string, now time.Time) placement {
	trimmed := strings.TrimSpace(details)
	if trimmed == ModelImageInputError || trimmed == ModelImageInputUnknown {
		return placement{kind: "model", recovery: "model"}
	}
	// "429: {...}", "429 {...}", or the model runtime's "<provider> API error (429): {...}".
	prefixEnd := 0
	prefixStatus := ""
	prefixBareStatus := ""
	if match := runErrorPrefixRE.FindStringSubmatchIndex(trimmed); match != nil {
		prefixEnd = match[1]
		if match[2] >= 0 {
			prefixStatus = trimmed[match[2]:match[3]]
		}
		if match[4] >= 0 {
			prefixBareStatus = trimmed[match[4]:match[5]]
		}
	}
	// A streamed error event arrives as an SSE frame, "data: {...}".
	body := dataPrefixRE.ReplaceAllString(trimmed[prefixEnd:], "")
	record := asRecord(parseJSON(body))
	if fallback, ok := parseModelFallbackFailure(trimmed); ok {
		// The primary's message alone would hide the backups' failures.
		return classifyRunError(fallback.PrimaryError, now)
	}
	if IsComputerAllowanceUsed(trimmed) {
		return placement{recovery: "plan"}
	}
	if appRunErrors[trimmed] {
		switch {
		case modelOutputRunErrors[trimmed]:
			return placement{kind: "output"}
		case modelConnectionRunErrors[trimmed]:
			return placement{recovery: "connection"}
		default:
			return placement{}
		}
	}
	if trimmed == internalRunError {
		return placement{}
	}
	if trimmed == ModelOutputCutError {
		return placement{recovery: "model", kind: "output"}
	}
	if trimmed == ModelContextTooSmallError ||
		trimmed == ModelRequestLimitError ||
		trimmed == VerbatimToolResultTooLargeError {
		return placement{recovery: "model", kind: "context"}
	}
	if malformedKeyHeaderRE.MatchString(trimmed) {
		return placement{recovery: "connection", kind: "auth"}
	}

	errorRecord := asRecord(record["error"])
	payload := record
	if len(errorRecord) > 0 {
		payload = errorRecord
	}
	// Gateways in front of Google pass Google's own error envelope as a JSON string message.
	if wrappedMessage, ok := payload["message"].(string); ok {
		wrapped := asRecord(asRecord(parseJSON(wrappedMessage))["error"])
		if len(wrapped) > 0 {
			payload = wrapped
		}
	}
	message := body
	if payloadMessage, ok := payload["message"].(string); ok {
		message = payloadMessage
	}

	status := 0
	hasStatus := false
	candidates := []any{
		prefixStatus,
		prefixBareStatus,
		record["status"],
		record["code"],
		payload["code"],
		payload["httpCode"],
	}
	for _, candidate := range candidates {
		if value, ok := jsInteger(candidate); ok && value >= 100 && value <= 599 {
			status = value
			hasStatus = true
			break
		}
	}
	if !hasStatus && strings.HasPrefix(trimmed, "AccessDeniedException") &&
		(len(trimmed) == len("AccessDeniedException") || !isWordByte(trimmed[len("AccessDeniedException")])) {
		// Bedrock names its modeled exception instead of reporting the HTTP status.
		status = 403
		hasStatus = true
	}
	atStatus := func(want int) bool { return hasStatus && status == want }

	if IsContentFilterRejection(trimmed) {
		return placement{recovery: "model", kind: "output", status: status, hasStatus: hasStatus}
	}
	// Output diagnostics can quote generated text that mentions a timeout or a quota.
	if trimmed == ModelOutputLimitError ||
		modelOutputFailureRE.MatchString(trimmed) ||
		modelOutputFailureRE.MatchString(message) {
		return placement{recovery: "model", kind: "output", status: status, hasStatus: hasStatus}
	}

	metadataValue := record["metadata"]
	if value, ok := payload["metadata"]; ok && value != nil {
		metadataValue = value
	}
	metadata := asRecord(metadataValue)
	detailsValue := any("")
	if value, ok := payload["details"]; ok && value != nil {
		detailsValue = value
	}
	signals := strings.Join([]string{
		message,
		jsonSignal(metadata),
		jsonSignal(detailsValue),
		jsValueString(payload["type"]),
		jsValueString(payload["code"]),
		jsValueString(payload["status"]),
		jsValueString(payload["param"]),
	}, " ")

	financialQuota := financialQuotaRE.MatchString(signals)
	// A 429 that resets hours from now is a quota to wait out, not a short rate window.
	quotaReset := false
	if atStatus(429) {
		_, quotaReset = ProviderQuotaResetAt(trimmed, now)
	}

	var kind string
	var recovery string
	if !atStatus(413) &&
		!quotaReset &&
		(atStatus(429) || rateSignalsRE.MatchString(signals)) &&
		// OpenAI's per-minute limits link to billing as a way to raise them.
		(!financialQuota || rpmTPMRE.MatchString(signals)) {
		kind = "rate"
	} else if atStatus(402) || quotaReset || limitSignalsRE.MatchString(signals) {
		// OpenRouter names the limit that tripped. "Make sure your key is on the correct
		// account" in a credit error is not a key limit.
		limitSource, _ := metadata["limit_source"].(string)
		var limitKind string
		if limitSource != "" {
			if strings.Contains(limitSource, "key_limit") {
				limitKind = "key"
			}
		} else if keyLimitRE.MatchString(signals) {
			limitKind = "key"
		}
		if limitKind == "" {
			if creditSignalRE.MatchString(signals) {
				limitKind = "credit"
			} else {
				limitKind = "spending"
			}
		}
		kind = limitKind
		// A capped key is fixed by connecting another; an account out of money or quota
		// is not, but another model keeps the user going.
		recovery = "model"
		if kind == "key" {
			recovery = "connection"
		}
	} else if param, ok := payload["param"].(string); ok && maxTokensParamRE.MatchString(param) {
		// The model's own output cap is below what every run asks for, so retrying cannot help.
		recovery = "model"
		kind = "context"
	} else if atStatus(413) || contextSignalsRE.MatchString(signals) {
		kind = "context"
	} else if atStatus(429) {
		kind = "rate"
	} else if atStatus(401) ||
		// A personal access token pasted where the provider only accepts its own sign-in token.
		(!(hasStatus && status >= 500) && personalAccessTokensRE.MatchString(signals)) ||
		((atStatus(403) || invalidKeySignalsRE.MatchString(signals)) &&
			authWordRE.MatchString(signals)) {
		recovery = "connection"
		kind = "auth"
	} else if atStatus(403) || jsValueString(payload["code"]) == "model_terms_required" {
		// The key works, but the provider refuses this model to the account or plan.
		recovery = "model"
		kind = "access"
	} else if atStatus(404) ||
		atStatus(410) ||
		jsValueString(payload["param"]) == "model" ||
		modelNotFoundSignalsRE.MatchString(signals) ||
		(!(hasStatus && status >= 500) && modelUnavailable(message)) {
		recovery = "model"
		kind = "model"
	} else if atStatus(502) || atStatus(503) || atStatus(529) || overloadSignalsRE.MatchString(signals) {
		// Provider overload; the summary layer adds its own wording.
	} else if connectionErrorRE.MatchString(strings.TrimSpace(message)) ||
		connectionSignalsRE.MatchString(signals) {
		// Unreachable provider; no recovery action.
	} else if atStatus(408) || atStatus(504) || timeoutSignalsRE.MatchString(signals) {
		// Timeout; the summary layer adds its own wording.
	} else if atStatus(400) &&
		jsValueString(payload["type"]) == "invalid_request_error" &&
		effortLevelRE.MatchString(message) {
		// The organization caps the thinking effort below the one chosen for this model.
		recovery = "model"
	} else if atStatus(400) &&
		message == "Provider returned error" &&
		metadataProviderName(metadata) != "" {
		// A gateway's named upstream refused the request; another model avoids that upstream.
		recovery = "model"
	} else if modelOutputLimitReachedRE.MatchString(message) {
		recovery = "model"
		kind = "output"
	}
	return placement{kind: kind, recovery: recovery, status: status, hasStatus: hasStatus}
}

func metadataProviderName(metadata map[string]any) string {
	name, _ := metadata["provider_name"].(string)
	return strings.TrimSpace(name)
}

// modelUnavailable ports MODEL_UNAVAILABLE from run-error.ts. Go's regexp has
// no lookahead, and the pattern uses two: a suffix that disqualifies
// "unsupported model parameters", and a scan of up to 80 characters that may
// not cross a ". " sentence boundary. Both are implemented by hand.
func modelUnavailable(message string) bool {
	if modelUnavailableOtherRE.MatchString(message) {
		return true
	}
	if match := unsupportedModelRE.FindStringIndex(message); match != nil && match[0] == 0 {
		if !modelParameterSuffixRE.MatchString(message[match[1]:]) {
			return true
		}
	}
	for _, word := range modelWordRE.FindAllStringIndex(message, -1) {
		pos := word[1]
		units := 0
		for {
			if hasWordBoundaryBefore(message, pos) && modelUnavailableKeywordRE.MatchString(message[pos:]) {
				return true
			}
			if units >= 80 || pos >= len(message) {
				break
			}
			current, size := utf8.DecodeRuneInString(message[pos:])
			if current == '.' {
				next, _ := utf8.DecodeRuneInString(message[pos+1:])
				// The worker forbids consuming a period that ends a sentence.
				if isJSSpace(next) {
					break
				}
			}
			pos += size
			units++
			if current > 0xFFFF {
				units++
			}
			if units > 80 {
				break
			}
		}
	}
	return false
}

func hasWordBoundaryBefore(text string, pos int) bool {
	if pos <= 0 || pos >= len(text) {
		return true
	}
	return isWordByte(text[pos-1]) != isWordByte(text[pos])
}

func isWordByte(value byte) bool {
	return value == '_' ||
		(value >= '0' && value <= '9') ||
		(value >= 'a' && value <= 'z') ||
		(value >= 'A' && value <= 'Z')
}

// isJSSpace reports whether r is in ECMAScript's \s set.
func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', '\u00a0', '\u1680', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff':
		return true
	}
	return r >= '\u2000' && r <= '\u200a'
}

func jsInteger(value any) (int, bool) {
	number := jsNumber(value)
	if math.IsNaN(number) || math.IsInf(number, 0) || math.Trunc(number) != number {
		return 0, false
	}
	return int(number), true
}

// jsNumber mirrors Number(value) for the JSON shapes a provider envelope can
// hold: numbers, strings and booleans.
func jsNumber(value any) float64 {
	switch typed := value.(type) {
	case nil:
		return 0
	case float64:
		return typed
	case bool:
		if typed {
			return 1
		}
		return 0
	case string:
		text := strings.TrimSpace(typed)
		if text == "" {
			return 0
		}
		if number, err := strconv.ParseFloat(text, 64); err == nil {
			return number
		}
		if number, err := strconv.ParseUint(text, 0, 64); err == nil {
			return float64(number)
		}
		return math.NaN()
	default:
		return math.NaN()
	}
}

// jsValueString mirrors String(value ?? "") for values read out of JSON.
func jsValueString(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	case float64:
		return strconv.FormatFloat(typed, 'g', -1, 64)
	case bool:
		if typed {
			return "true"
		}
		return "false"
	default:
		return jsonSignal(value)
	}
}

func jsonSignal(value any) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return ""
	}
	return string(encoded)
}

func parseJSON(text string) any {
	var value any
	if err := json.Unmarshal([]byte(text), &value); err != nil {
		return nil
	}
	return value
}

func asRecord(value any) map[string]any {
	record, ok := value.(map[string]any)
	if !ok {
		return map[string]any{}
	}
	return record
}

var (
	runErrorPrefixRE = regexp.MustCompile(`^(?:[^\n():]{1,60} API error \((\d{3})\):\s*|(\d{3})(?:\s*:\s*|\s+))`)

	dataPrefixRE = regexp.MustCompile(`^data:\s*`)

	modelOutputFailureRE = regexp.MustCompile(`^(?:Provider (?:finish_reason|stopped with): |Unhandled stop reason: |Provider returned an empty response\b|Failed to parse tool call arguments as JSON\b|[Tt]ool call validation failed\b|Parsing failed\. The model generated output that could not be parsed\b|Upstream request failed: \[api_error\] Upstream response was not valid JSON\b|The model refused to complete the request\b|(?:Codex error: )?This content was flagged for possible cybersecurity risk\b|Cyber safeguards flagged this message\b|This request triggered cyber-related safeguards\b|(?:SAFETY|BLOCKLIST|PROHIBITED_CONTENT|SPII|RECITATION|IMAGE_(?:SAFETY|PROHIBITED_CONTENT|RECITATION))` + jsEnd + `|This request (?:triggered restrictions on [^\n.]{1,80} and )?was blocked (?:under|as it seems to violate) Anthropic's |(?:[\w.]+Error: )?unexpected tokens remaining in message header:)`)

	modelOutputLimitReachedRE = regexp.MustCompile(`(?i)\bcut ?off by max_(?:completion_|output_)?tokens\b`)

	malformedKeyHeaderRE = regexp.MustCompile(`^(?:TypeError: )?(?:Headers\.append: "[\s\S]*" is an invalid header value\.|Cannot convert argument to a ByteString because the character at index \d+ has a value of \d+ which is greater than 255\.)` + jsEnd)

	financialQuotaRE = regexp.MustCompile(`(?i)insufficient[_ ](?:quota|balance)|credits?|funds|spend|budget|billing|openrouter_key_limit`)

	rateSignalsRE = regexp.MustCompile(`(?i)rate[_ -]limit|too many requests|resource[_ ]?exhausted|request limit reached`)

	rpmTPMRE = regexp.MustCompile(`(?i)\b(?:rpm|tpm)\b`)

	limitSignalsRE = regexp.MustCompile(`(?i)\b(?:daily|weekly|monthly|usage)[\s\S]{0,30}limit|\b(?:quota|insufficient[_ ](?:quota|credits?|funds|balance)|credit[_ ]balance|(?:no|out of|more) credits?)\b|(?:key|credit|spend|spending|budget|billing)[\s\S]{0,40}(?:limit|exceed|exhaust|insufficient)|(?:limit|insufficient)[\s\S]{0,30}(?:credit|spend|budget)|\blimit exceeded\b[\s\S]{0,120}\bupgrade to a paid account\b`)

	keyLimitRE = regexp.MustCompile(`(?i)key[_ ]limit|\bkey\b[^.]{0,30}\blimit\b`)

	creditSignalRE = regexp.MustCompile(`(?i)credit|insufficient_quota|free[_ -]tier`)

	maxTokensParamRE = regexp.MustCompile(`^max_(?:completion_|output_)?tokens$`)

	contextSignalsRE = regexp.MustCompile(`(?i)context[_ -](?:length|size|window)|maximum context|exceeds the model context|prompt is too long|too many (?:tokens|images)|request too large`)

	personalAccessTokensRE = regexp.MustCompile(`(?i)\bpersonal access tokens are not supported\b`)

	invalidKeySignalsRE = regexp.MustCompile(`(?i)(?:invalid|incorrect)[_ -](?:api[_ -])?key|api[_ -]?key[_ -](?:invalid|expired)|authentication_error|\bauthentication token (?:has|is) expired\b|\binvalidated oauth token\b|\bapi key is not scoped to a workspace\b`)

	authWordRE = regexp.MustCompile(`(?i)auth|unauthorized|invalid|key`)

	modelNotFoundSignalsRE = regexp.MustCompile(`(?i)model[_ -]not[_ -](?:found|supported)`)

	overloadSignalsRE = regexp.MustCompile(`(?i)overload|over capacity|temporarily unavailable|service unavailable`)

	connectionErrorRE = regexp.MustCompile(`(?i)^connection error\.?$`)

	connectionSignalsRE = regexp.MustCompile(`(?i)ECONNREFUSED|connection refused|ENOTFOUND|getaddrinfo|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN`)

	timeoutSignalsRE = regexp.MustCompile(`(?i)timed?[_ -]?out|timeout|ETIMEDOUT|stream ended|\bterminated\b|socket hang up|ECONNRESET|connection reset|fetch failed|network error`)

	effortLevelRE = regexp.MustCompile(`(?i)^Invalid effort level\b`)

	unsupportedModelRE = regexp.MustCompile(`(?i)^(?:unsupported|unknown|unrecognized)[ _-]model\b`)

	modelParameterSuffixRE = regexp.MustCompile(`(?i)^[ :]+(?:parameters?|fields?|options?|settings?)\b`)

	modelWordRE = regexp.MustCompile(`(?i)\bmodel\b`)

	modelUnavailableOtherRE = regexp.MustCompile(`(?i)\bnot supported (?:with|by|for) (?:this|the) model\b|^feature 'tool calls' is not (?:currently )?supported\b|^invalid inference request\. check the model's supported parameters\b|\bdegraded function cannot be invoked\b`)

	// The keywords that may follow "model" within the same sentence. The worker
	// writes this group with a leading \b, which hasWordBoundaryBefore applies.
	modelUnavailableKeywordRE = regexp.MustCompile(`(?i)^(?:not found|does not exist|unavailable|not available|not supported|isn['\x{2019}]t supported|(?:is|has been) deprecated|does(?: not|n['\x{2019}]t) support|requires the use of|requires [\w -]{1,30}\bregions?|is hosted outside\b|is not a chat model|only supports (?:the )?(?:/|[\w ./-]{1,40}\b(?:endpoint|api)\b))`)
)

var (
	modelOutputRunErrors = map[string]bool{
		MissingToolFinalResponseError: true,
		ApprovedActionNotRunError:     true,
	}

	modelConnectionRunErrors = map[string]bool{
		MissingModelRunError:            true,
		HostedModelCreditsRequiredError: true,
		ModelCreditsExhaustedError:      true,
		ModelUnpricedForCreditsError:    true,
	}

	appRunErrors = map[string]bool{
		MissingToolFinalResponseError:    true,
		ApprovedActionNotRunError:        true,
		MissingModelRunError:             true,
		HostedModelCreditsRequiredError:  true,
		ModelCreditsExhaustedError:       true,
		ModelUnpricedForCreditsError:     true,
		ModelAccessRequiredRunError:      true,
		ModelCreditCapReachedError:       true,
		ComputerRateLimitError:           true,
		ComputerProviderUnavailableError: true,
		ComputerUnresponsiveError:        true,
		StuckWorkQueuedMessage:           true,
		StuckWorkWaitingInputMessage:     true,
		StuckWorkWaitingTakeoverMessage:  true,
	}
)
