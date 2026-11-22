package modelretry

import (
	"regexp"
	"strconv"
	"strings"
	"time"
)

// errorFacts lowercases the message and collects every HTTP status it reports.
// The worker reads structured fields from Error objects; a Go caller only has
// the provider's message, so the same statuses are read from its text in the
// order they appear.
func errorFacts(message string) (string, []int) {
	text := strings.ToLower(message)
	matches := statusFactRE.FindAllStringSubmatch(text, -1)
	statuses := make([]int, 0, len(matches))
	for _, match := range matches {
		status, err := strconv.Atoi(match[1])
		if err == nil {
			statuses = append(statuses, status)
		}
	}
	return text, statuses
}

func hasAnyStatus(statuses []int, wanted ...int) bool {
	for _, status := range statuses {
		for _, want := range wanted {
			if status == want {
				return true
			}
		}
	}
	return false
}

func hasServerErrorStatus(statuses []int) bool {
	for _, status := range statuses {
		if status >= 500 && status < 600 {
			return true
		}
	}
	return false
}

func hasClientOrServerErrorStatus(statuses []int) bool {
	for _, status := range statuses {
		if status >= 400 && status < 600 {
			return true
		}
	}
	return false
}

// IsTransient reports whether retrying the same model can clear the failure:
// overload, rate limit, 5xx, timeout or a dropped connection. Quota, billing,
// auth and input errors are permanent for this model. The check reads provider
// text as well as the statuses it names.
func IsTransient(message string) bool {
	return isTransientAt(message, time.Now())
}

func isTransientAt(message string, now time.Time) bool {
	text, statuses := errorFacts(message)
	// Payment required never clears during a retry.
	if hasAnyStatus(statuses, 402) {
		return false
	}
	// An exhausted account stays exhausted; retrying the same model cannot help.
	if isAccountExhaustion(text, statuses) {
		return false
	}
	// A limit the provider says resets hours from now will not clear during a retry.
	if _, ok := ProviderQuotaResetAt(text, now); ok {
		return false
	}
	// Short rate windows can reset during a retry; subscription and billing limits cannot.
	shortWindow := shortWindowRE.MatchString(text) || concurrencyLimitRE.MatchString(text)
	return IsRetryableProviderUnavailable(message) &&
		!transientQuotaRE.MatchString(text) &&
		// OpenAI's per-minute limits link to billing as a way to raise them.
		(shortWindow || !billingRE.MatchString(text))
}

// IsRetryableProviderUnavailable reports whether only provider availability
// failed: an explicit exhausted account, a rate limit, a timeout, a dropped
// connection or a 5xx. A configured backup can serve such a call even when the
// same model must not be retried.
func IsRetryableProviderUnavailable(message string) bool {
	text, statuses := errorFacts(message)
	if hasAnyStatus(statuses, 401) {
		return false
	}
	if isAccountExhaustion(text, statuses) {
		return true
	}
	// The provider timed out fetching a file the request links to; another attempt fetches it again.
	if downloadTimeoutRE.MatchString(text) {
		return true
	}
	// Some providers report concurrency limits with HTTP 400 instead of 429.
	if concurrencyLimitRE.MatchString(text) && !NamesPermanentFailure(message) {
		return true
	}
	if hasAnyStatus(statuses, 400) {
		return false
	}
	// The ChatGPT subscription (Codex) runtime reports an exhausted usage window without a status.
	if strings.Contains(text, "you have hit your chatgpt usage limit") {
		return true
	}
	if hasAnyStatus(statuses, 400, 401, 403) || statusText400To403RE.MatchString(text) {
		return false
	}
	if permanentFailureWordsRE.MatchString(text) || invalidKeyHeaderRE.MatchString(text) {
		return false
	}
	// Some providers label payment failures with a generic invalid_request_error code.
	// Their explicit balance error still means a configured backup can serve the call.
	insufficientBalance := hasAnyStatus(statuses, 402) && insufficientBalanceErrorRE.MatchString(text)
	if permanentFailureCodesRE.MatchString(text) || (!insufficientBalance && strings.Contains(text, "invalid_request")) {
		return false
	}
	if hasAnyStatus(statuses, 402) {
		return paymentLimitRE.MatchString(text)
	}
	if hasAnyStatus(statuses, 408, 429) || hasServerErrorStatus(statuses) {
		return true
	}
	if hasClientOrServerErrorStatus(statuses) {
		return false
	}
	return availabilityTextRE.MatchString(text)
}

// IsCredentialRejected reports whether the provider refused the connection's
// own credential: a bad key, or a sign-in that was revoked or expired.
// Retrying that connection cannot help; another connection can.
func IsCredentialRejected(message string) bool {
	text, statuses := errorFacts(message)
	if hasAnyStatus(statuses, 401) {
		return true
	}
	return credentialRejectedRE.MatchString(text)
}

// NamesPermanentFailure reports whether the failure puts the request or the
// caller at fault: cancelled, unauthorised, invalid, too large, or for a model
// the provider does not serve. Repeating such a request fails the same way.
func NamesPermanentFailure(message string) bool {
	text, _ := errorFacts(message)
	return permanentFailureWordsRE.MatchString(text) ||
		invalidKeyHeaderRE.MatchString(text) ||
		permanentFailureCodesRE.MatchString(text) ||
		strings.Contains(text, "invalid_request")
}

// Status returns the first HTTP status the failure names in its text. The
// worker also reads status fields from Error objects; a Go caller has provider
// text, so only text statuses are available here.
func Status(message string) (int, bool) {
	_, statuses := errorFacts(message)
	if len(statuses) == 0 {
		return 0, false
	}
	return statuses[0], true
}

// IsContentFilterRejection reports whether a provider error says its content
// filter refused the request. Providers name the refusal in a JSON body that
// may itself be escaped inside another JSON string.
func IsContentFilterRejection(details string) bool {
	return contentFilterCodeRE.MatchString(details)
}

// ProviderQuotaResetAt returns when an exhausted provider limit resets, if the
// provider says that is over an hour away. Gateways copy the response's
// X-RateLimit-Reset (an epoch in seconds or milliseconds) or Retry-After
// (seconds) headers into the error body, which is all a model runtime passes
// on. A limit that resets within the hour is a short rate window a retry can
// wait out, so it reports false.
func ProviderQuotaResetAt(text string, now time.Time) (time.Time, bool) {
	if epochMillis, ok := quotaResetEpoch(text); ok {
		resetAt := time.UnixMilli(epochMillis)
		if resetAt.Sub(now) > time.Hour {
			return resetAt, true
		}
		return time.Time{}, false
	}
	if seconds, ok := quotaResetDelay(text); ok {
		resetAt := now.Add(time.Duration(seconds) * time.Second)
		if resetAt.Sub(now) > time.Hour {
			return resetAt, true
		}
		return time.Time{}, false
	}
	return time.Time{}, false
}

// quotaResetEpoch finds the first X-RateLimit-Reset epoch whose digit run is
// 10 to 13 digits long. The worker's lookahead rejects a 14-digit run but still
// matches a later, valid header; the loop keeps that behavior.
func quotaResetEpoch(text string) (int64, bool) {
	for _, match := range quotaResetEpochRE.FindAllStringSubmatch(text, -1) {
		digits := match[1]
		if len(digits) > 13 {
			continue
		}
		value, err := strconv.ParseInt(digits, 10, 64)
		if err != nil {
			continue
		}
		if len(digits) > 10 {
			return value, true
		}
		return value * 1000, true
	}
	return 0, false
}

// quotaResetDelay finds the first Retry-After delay whose number is not
// followed by a dot or another digit. The worker's lookahead rejects
// "retry-after: 12.5" but still matches a later header.
func quotaResetDelay(text string) (int64, bool) {
	for _, match := range quotaResetDelayRE.FindAllStringSubmatchIndex(text, -1) {
		digits := text[match[2]:match[3]]
		end := match[3]
		if end < len(text) && (text[end] == '.' || (text[end] >= '0' && text[end] <= '9')) {
			continue
		}
		value, err := strconv.ParseInt(digits, 10, 64)
		if err != nil {
			// Beyond int64 seconds is far past the hour threshold.
			return 1 << 31, true
		}
		return value, true
	}
	return 0, false
}

func isAccountExhaustion(text string, statuses []int) bool {
	if hasAnyStatus(statuses, 401) {
		return false
	}
	if !hasAnyStatus(statuses, 400, 402, 403) {
		return false
	}
	return exhaustionSignalRE.MatchString(text) && !notExhaustionRE.MatchString(text)
}

// jsEnd stands in for ECMAScript's `$`, which also matches before one trailing
// line terminator. Go's `$` without (?m) does not.
const jsEnd = `(?:\r\n|[\n\r\x{2028}\x{2029}])?\z`

var (
	// The worker also reads status, statusCode and httpStatus fields from Error
	// objects. This package only receives text, so it finds statuses the way the
	// worker's text pass does.
	statusFactRE = regexp.MustCompile(`(?i)(?:\b(?:http(?:\s+status(?:\s+code)?)?|status(?:\s+code)?|error\s+code)\s*(?:[:=]\s*)?|\bapi error\s*\(\s*|^\s*)([45]\d{2})\b`)

	exhaustionSignalRE = regexp.MustCompile(`insufficient[ _](?:credits?|funds|balance|quota)|(?:out of|no (?:more|remaining)) (?:credits?|balance|quota)|credits? (?:have been |are |is )?(?:exhausted|depleted|used up)|(?:credit )?balance (?:is )?(?:too )?(?:low|empty|insufficient|exhausted|depleted)|(?:low|empty|insufficient|exhausted|depleted) (?:credit )?balance|(?:purchase|buy|add) more credits|(?:exceeded|exhausted|used up) your (?:current )?quota|quota (?:exceeded|exhausted)|(?:reached|hit) your (?:[a-z0-9()-]+ ){0,4}usage limit|usage limit (?:reached|exceeded)|out of budget`)

	notExhaustionRE = regexp.MustCompile(`not (?:yet )?(?:reached|hit)|unsupported parameter|invalid[ _](?:api[ _]key|parameter|param|input|argument|tool|schema|credential)|validation|must be|context[ _-](?:length|window)|too many tokens|model not found|bad request|unauthori[sz]ed|forbidden|access denied|permission (?:is )?(?:denied|refused|declined)|(?:expired|revoked|missing) (?:api )?(?:key|credential|token)|(?:api )?(?:key|credential|token) (?:expired|revoked|missing)|authentication (?:failed|failure|denied|expired|invalid)|abort|cancel|\bper[- ](?:second|minute)\b|\b(?:rpm|tpm)\b|concurrent`)

	credentialRejectedRE = regexp.MustCompile(`authentication_error|invalid_api_key|invalid_grant|invalid (?:api[ -]key|credential|x-api-key)|incorrect api key|(?:expired|revoked) (?:api )?(?:key|credential|token)|(?:api )?(?:key|credential|token) (?:expired|revoked)|token (?:has been |was |is )?(?:revoked|expired|invalidated)|authentication (?:failed|failure|expired|invalid)|api key is not scoped to a workspace`)

	permanentFailureWordsRE = regexp.MustCompile(`\b(abort(?:ed)?|cancel(?:lation|led|ed)?|unauthori[sz]ed|forbidden|permission(?: is)? (?:denied|refused|declined)|access denied|consent(?: is)? (?:required|denied|refused|declined|not granted)|user (?:refused|declined)|invalid api key|invalid credential|(?:expired|revoked|missing) (?:api )?(?:key|credential|token)|(?:api )?(?:key|credential|token) (?:expired|revoked|missing)|authentication (?:failed|failure|denied|expired|invalid)|authorization (?:failed|failure|denied|expired|invalid)|bad request|invalid request|invalid input|invalid argument|context length|model not found|unsupported parameter)\b`)

	// Fetch refused a key that is not a valid header value; the quoted key can read like anything.
	invalidKeyHeaderRE = regexp.MustCompile(`\bheaders\.append: "[\s\S]*" is an invalid header value\.|\bcannot convert argument to a bytestring because\b`)

	permanentFailureCodesRE = regexp.MustCompile(`context[ _-](?:length|window)|too many tokens|maximum context|token limit|request too large|invalid_api_key|authentication_error|permission_error|bad_request`)

	downloadTimeoutRE = regexp.MustCompile(`\b(?:download\w*\b[^.]{0,40}\b(?:file|image|media|url)|(?:file|image|media|url)\w*\s+download\w*)\b[^.]{0,20}\btimed? ?out\b`)

	statusText400To403RE = regexp.MustCompile(`\b(?:http(?:\s+status(?:\s+code)?)?|status(?:\s+code)?|error\s+code)\s*(?:[:=]\s*)?(?:400|401|403)\b`)

	insufficientBalanceErrorRE = regexp.MustCompile(`\binsufficient_balance_error\b`)

	paymentLimitRE = regexp.MustCompile(`quota|billing|credit|payment limit|insufficient (?:funds|balance)|insufficient_balance_error`)

	availabilityTextRE = regexp.MustCompile(`rate.?limit|too many requests|resource.?exhausted|request limit reached|quota|overload|capacity|temporarily unavailable|service unavailable|retry[- ](?:after|delay)|server[ _]error|upstream error|an error occurred while processing your request|could not complete this request\. please retry|gateway timeout|timed? out|timeout|connection (?:error|reset|refused)|network[ _]error|max retries exceeded|stream ended (?:without (?:a )?finish[_ ]reason|before \w+)|json error injected into sse stream|stream interrupted|incomplete json segment at the end|\bterminated\b|fetch failed|socket hang up|econnreset|econnrefused|etimedout|websocket closed`)

	shortWindowRE = regexp.MustCompile(`\bper[- ](?:second|minute)\b|\b(?:rpm|tpm)\b|retry[- ]after[: ]+\d+(?:\.\d+)?\s*(?:seconds?|secs?|s)\b`)

	concurrencyLimitRE = regexp.MustCompile(`\b(?:concurren(?:cy|t[ _-]requests?)[ _-]limit[ _-]?(?:exceeded|reached|hit)|too many concurrent requests?|exceeded (?:your |the )?(?:max(?:imum)? )?concurrent requests?)\b`)

	transientQuotaRE = regexp.MustCompile(`insufficient_quota|exceeded your current quota|quota exhausted|(?:chatgpt|5-hour|weekly(?: \(7-day\))?|monthly) usage limit|credit balance|insufficient (?:funds|balance|credits)|out of budget`)

	billingRE = regexp.MustCompile(`billing|payment|usage limit`)

	quotaResetEpochRE = regexp.MustCompile(`(?i)\bx-ratelimit-reset\\?"?\s*[:=]\s*\\?"?(\d{10,})`)

	quotaResetDelayRE = regexp.MustCompile(`(?i)\bretry-after\\?"?\s*[:=]\s*\\?"?(\d+)`)

	contentFilterCodeRE = regexp.MustCompile(`\\*"(?:code|type)\\*"\s*:\s*\\*"(?:data_inspection_failed|content_filter|content_policy_violation)\\*"`)
)
