package modelretry

import (
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestModelUnavailableLookaround(t *testing.T) {
	t.Parallel()

	cases := []struct {
		message string
		want    bool
	}{
		{"unsupported model", true},
		{"UNSUPPORTED MODEL", true},
		{"unknown_model", true},
		{"unsupported model parameters", false},
		{"unsupported model parameter", false},
		{"unsupported model fields", false},
		{"unknown model options", false},
		{"unrecognized model settings", false},
		{"unsupported model-parameters", true},
		{"The model example-model is not available", true},
		{"The model is deprecated", true},
		{"The model does not support tool use", true},
		{"The model isn’t supported", true},
		{"The model only supports the /v1 endpoint", true},
		{"The model requires Global regions", true},
		{"The model is hosted outside Europe", true},
		{"The model is not a chat model", true},
		{"model not found", true},
		{"model\nnot found", true},
		{"model x. x not found", false},
		{"model x.x not found", true},
		{"not supported with this model", true},
		{"feature 'tool calls' is not currently supported", true},
		{"Invalid inference request. Check the model's supported parameters", true},
		{"DEGRADED function cannot be invoked", true},
		{"model " + strings.Repeat("a", 75) + " not found", true},
		{"model " + strings.Repeat("a", 79) + " not found", false},
	}
	for _, testCase := range cases {
		if got := modelUnavailable(testCase.message); got != testCase.want {
			t.Errorf("modelUnavailable(%q) = %t, want %t", testCase.message, got, testCase.want)
		}
	}
}

func TestProviderQuotaResetAtLookahead(t *testing.T) {
	t.Parallel()

	now := time.UnixMilli(1_795_176_000_000) // 2026-11-20T12:00:00Z
	twoHours := now.Add(2 * time.Hour)
	epochSeconds := twoHours.Unix()
	epochMillis := twoHours.UnixMilli()
	cases := []struct {
		name    string
		text    string
		want    time.Time
		matched bool
	}{
		{"epoch seconds", "x-ratelimit-reset: " + itoa64(epochSeconds), twoHours, true},
		{"epoch milliseconds", `"X-RateLimit-Reset": ` + itoa64(epochMillis), twoHours, true},
		{"escaped header", `x-ratelimit-reset\": ` + itoa64(epochSeconds), twoHours, true},
		{"ten digits", "x-ratelimit-reset=1234567890", time.UnixMilli(1_234_567_890_000), false},
		{"nine digits", "x-ratelimit-reset: 123456789", time.Time{}, false},
		{"fourteen digits", "x-ratelimit-reset: " + itoa64(epochMillis) + "0", time.Time{}, false},
		{"later valid epoch after rejected one", "x-ratelimit-reset: " + itoa64(epochMillis) + "0; x-ratelimit-reset: " + itoa64(epochSeconds), twoHours, true},
		{"retry after two hours", "retry-after: 7200", twoHours, true},
		{"retry after exactly one hour", "retry-after: 3600", time.Time{}, false},
		{"retry after a decimal", "retry-after: 7200.5", time.Time{}, false},
		{"retry after a later valid header", "retry-after: 7200.5; retry-after: 7200", twoHours, true},
		{"retry after trailing text", "retry-after: 7200s", twoHours, true},
		{"epoch wins over delay", "x-ratelimit-reset: " + itoa64(epochSeconds-3600) + "; retry-after: 7200", time.Time{}, false},
	}
	for _, testCase := range cases {
		resetAt, matched := ProviderQuotaResetAt(testCase.text, now)
		if matched != testCase.matched {
			t.Errorf("%s: matched = %t, want %t", testCase.name, matched, testCase.matched)
			continue
		}
		if matched && !resetAt.Equal(testCase.want) {
			t.Errorf("%s: resetAt = %d, want %d", testCase.name, resetAt.UnixMilli(), testCase.want.UnixMilli())
		}
	}
}

func TestTerminalOAuthRefreshMarker(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name    string
		message string
		want    string
	}{
		{
			name:    "terminal status and marker",
			message: `OAuth refresh failed for anthropic: details=Error: HTTP request failed. status=400; body={"error": "invalid_grant"}`,
			want:    "invalid_grant",
		},
		{
			name:    "401 marker",
			message: `refresh failed (401): token refresh failed: refresh_token_expired`,
			want:    "refresh_token_expired",
		},
		{
			name:    "server error vetoes",
			message: `refresh failed: status=500; body={"error": "invalid_grant"}`,
			want:    "",
		},
		{
			name:    "marker without terminal status",
			message: `refresh failed: body={"error": "invalid_grant"}`,
			want:    "",
		},
		{
			name:    "marker inside a longer token",
			message: `refresh failed: status=400; body={"error": "not_invalid_grant"}`,
			want:    "",
		},
		{
			name:    "http status shape",
			message: `OAuth refresh failed: HTTP 403; body=invalid_grant`,
			want:    "invalid_grant",
		},
		{
			name:    "kimi wording",
			message: `Kimi Code token refresh unauthorized (400)`,
			want:    "Kimi Code token refresh unauthorized",
		},
	}
	for _, testCase := range cases {
		if got := terminalOAuthRefreshErrorMarker(testCase.message); got != testCase.want {
			t.Errorf("%s: marker = %q, want %q", testCase.name, got, testCase.want)
		}
	}
}

func TestAppErrorPlacements(t *testing.T) {
	t.Parallel()

	cases := []struct {
		message  string
		kind     string
		recovery string
	}{
		{MissingToolFinalResponseError, "output", ""},
		{ApprovedActionNotRunError, "output", ""},
		{ModelOutputCutError, "output", "model"},
		{ModelContextTooSmallError, "context", "model"},
		{ModelRequestLimitError, "context", "model"},
		{VerbatimToolResultTooLargeError, "context", "model"},
		{MissingModelRunError, "", "connection"},
		{HostedModelCreditsRequiredError, "", "connection"},
		{ModelCreditsExhaustedError, "", "connection"},
		{ModelUnpricedForCreditsError, "", "connection"},
		{ModelAccessRequiredRunError, "", ""},
		{ModelCreditCapReachedError, "", ""},
		{ComputerRateLimitError, "", ""},
		{ComputerProviderUnavailableError, "", ""},
		{ComputerUnresponsiveError, "", ""},
		{StuckWorkQueuedMessage, "", ""},
		{StuckWorkWaitingInputMessage, "", ""},
		{StuckWorkWaitingTakeoverMessage, "", ""},
		{ComputerAllowanceUsedError, "", "plan"},
		{internalRunError, "", ""},
		{ModelImageInputError, "model", "model"},
		{ModelImageInputUnknown, "model", "model"},
	}
	now := time.UnixMilli(1_795_176_000_000)
	for _, testCase := range cases {
		got := classifyRunError(testCase.message, now)
		if got.kind != testCase.kind || got.recovery != testCase.recovery {
			t.Errorf("classifyRunError(%q) = kind %q recovery %q, want kind %q recovery %q",
				testCase.message, got.kind, got.recovery, testCase.kind, testCase.recovery)
		}
	}
}

func TestOwnEndpointFailureRanking(t *testing.T) {
	t.Parallel()

	const acceptedFailure = "The example endpoint failed after accepting the request."
	if got := Failure(acceptedFailure, "openai-compatible", "openai-compatible", true); got != ClassTransient {
		t.Errorf("own endpoint after accepting = %s, want %s", got, ClassTransient)
	}
	if got := Failure(acceptedFailure, "provider-a", "provider-a", true); got != ClassServer {
		t.Errorf("named provider after accepting = %s, want %s", got, ClassServer)
	}
	const badRequest = `400 {"detail":"Bad Request"}`
	if got := Failure(badRequest, "local", "local", false); got != ClassAccount {
		t.Errorf("own endpoint 400 = %s, want %s", got, ClassAccount)
	}
	if got := Failure(badRequest, "provider-a", "provider-a", false); got != ClassServer {
		t.Errorf("named provider 400 = %s, want %s", got, ClassServer)
	}
}

func TestContentFilterChain(t *testing.T) {
	t.Parallel()

	const filtered = `400 data: {"error":{"code":"data_inspection_failed","message":"blocked"}}`
	chain := `{"modelFallbackVersion":1,"primaryError":` + quoteJSON(filtered) +
		`,"backups":[{"provider":"provider-a","modelId":"backup","status":"failed","reason":` + quoteJSON(filtered) + `}]}`
	if got := Failure(chain, "provider-a", "provider-a", false); got != ClassContentFilter {
		t.Errorf("content-filter chain = %s, want %s", got, ClassContentFilter)
	}
	mixed := `{"modelFallbackVersion":1,"primaryError":` + quoteJSON(filtered) +
		`,"backups":[{"provider":"provider-a","modelId":"backup","status":"failed","reason":"terminated"}]}`
	if got := Failure(mixed, "provider-a", "provider-a", false); got != ClassOutput {
		t.Errorf("mixed filter chain = %s, want %s", got, ClassOutput)
	}
}

func quoteJSON(value string) string {
	var builder strings.Builder
	builder.WriteByte('"')
	for _, char := range value {
		switch char {
		case '\\', '"':
			builder.WriteByte('\\')
			builder.WriteRune(char)
		case '\n':
			builder.WriteString(`\n`)
		default:
			builder.WriteRune(char)
		}
	}
	builder.WriteByte('"')
	return builder.String()
}

func itoa64(value int64) string {
	return strconv.FormatInt(value, 10)
}

func TestRetryDelays(t *testing.T) {
	t.Parallel()

	want := [...]time.Duration{2 * time.Second, 8 * time.Second, 20 * time.Second}
	if RetryDelays != want {
		t.Fatalf("RetryDelays = %v, want %v", RetryDelays, want)
	}
}
