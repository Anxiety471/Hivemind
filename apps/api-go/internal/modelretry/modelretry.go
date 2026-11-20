// Package modelretry classifies model provider failures, chooses between a
// backup model and a same-model retry, and names the run error recovery the
// TypeScript worker reports. It is the Go side of the rules in
// packages/adapter-kit/src/model-errors.ts, packages/core/src/run-error.ts,
// packages/adapters/src/pi-runtime-errors.ts and the fallback loop in
// packages/adapters/src/pi-runtime-fallback.ts.
//
// Nothing calls this package yet. The bot run loop that makes model calls is
// still the TypeScript worker; this package is ready for the run-handoff slice
// that moves that loop to Go. It deliberately has no routes, gateway wiring or
// provider clients of its own.
package modelretry

import "time"

// Class is what a failed model call means for the run. The values rank the
// actions a user must take: a transient failure clears on its own, unusable
// output needs another try or model, an account failure needs the user's
// provider account or connection, and a server failure is Rakazo's or an
// unclassified fault. ContentFilter is kept apart because another model can
// serve the same conversation even though the current one refuses it.
type Class int

const (
	// ClassTransient clears on its own, such as an overloaded provider. Retrying
	// the same model can succeed.
	ClassTransient Class = iota
	// ClassOutput means the model returned nothing usable: an empty reply, a
	// malformed tool call, or output cut off at its limit.
	ClassOutput
	// ClassContentFilter means the provider's content filter refused the
	// conversation. The same request on the same model is refused again.
	ClassContentFilter
	// ClassAccount means the user's provider rejected the key, hit a credit or
	// usage limit, or no longer serves the model.
	ClassAccount
	// ClassServer is a failure no rule places. It stays a plain server error so a
	// request Rakazo built wrong is not blamed on the user.
	ClassServer
)

// String returns the corpus name of the class.
func (c Class) String() string {
	switch c {
	case ClassTransient:
		return "transient"
	case ClassOutput:
		return "output"
	case ClassContentFilter:
		return "content-filter"
	case ClassAccount:
		return "account"
	case ClassServer:
		return "server"
	default:
		return "unknown"
	}
}

// RetryDelays is the wait before each same-model retry of a provider failure
// that arrived before any visible output. It matches the worker's
// MODEL_PROVIDER_RETRY_DELAYS_MS; the caller bounds the total by its request
// budget.
var RetryDelays = [...]time.Duration{2 * time.Second, 8 * time.Second, 20 * time.Second}

// Decision is what the fallback loop does with a provider failure that arrived
// before any visible output.
type Decision struct {
	// SwitchToBackup says another configured model should serve the request. It
	// is false for failures no rule places.
	SwitchToBackup bool
	// RetrySameModel says the same model may be asked again. Only transient
	// failures and unexplained failures without a status qualify: a status means
	// the provider refused this exact request.
	RetrySameModel bool
}

// Failure classifies a provider failure for reporting. provider served the
// error; primaryProvider served the first model of a fallback chain.
// failedAfterAccepting means provider answered with a success status and then
// failed.
//
// When message is a persisted fallback envelope, every model that ran is
// considered: an unexplained failure keeps the run a server error, and a
// failure the user must fix outranks bad output, which outranks one that clears
// on its own. Skipped backups never ran, so they do not count. When every model
// that ran was refused by a content filter, the result is ClassContentFilter.
func Failure(message, provider, primaryProvider string, failedAfterAccepting bool) Class {
	fallback, ok := parseModelFallbackFailure(message)
	if !ok {
		if IsContentFilterRejection(message) {
			return ClassContentFilter
		}
		return rankToClass(failureRank(message, message, provider, failedAfterAccepting))
	}
	texts := make([]string, 0, len(fallback.Backups)+1)
	texts = append(texts, fallback.PrimaryError)
	failures := make([]fallbackModelFailure, 0, len(fallback.Backups)+1)
	failures = append(failures, fallbackModelFailure{Text: fallback.PrimaryError, Provider: primaryProvider})
	for _, backup := range fallback.Backups {
		if backup.Status != "failed" {
			continue
		}
		texts = append(texts, backup.Reason)
		failures = append(failures, fallbackModelFailure{Text: backup.Reason, Provider: backup.Provider})
	}
	allContentFilter := true
	for _, text := range texts {
		if !IsContentFilterRejection(text) {
			allContentFilter = false
			break
		}
	}
	if allContentFilter {
		return ClassContentFilter
	}
	worst := rankTransient
	for _, failure := range failures {
		rank := failureRank(failure.Text, failure.Text, failure.Provider, false)
		if rank > worst {
			worst = rank
		}
	}
	return rankToClass(worst)
}

// Decide chooses between a backup model and a same-model retry for a provider
// failure that arrived before any visible output. The caller has already
// established that the failure was not an abort and that no output reached the
// user. requestLimitTooSmall means the model's context window cannot fit the
// request at all, which another model can.
//
// A placed failure and an unexplained one both switch to the next backup. When
// no backup is left, RetrySameModel decides whether the same model is asked
// again.
func Decide(message, provider string, requestLimitTooSmall bool) Decision {
	placed := requestLimitTooSmall ||
		IsRetryableProviderUnavailable(message) ||
		IsCredentialRejected(message) ||
		IsContentFilterRejection(message)
	if !placed {
		unrecognized, ok := UnrecognizedFailure(message, provider)
		if !ok {
			return Decision{}
		}
		return Decision{
			SwitchToBackup: true,
			RetrySameModel: IsTransient(message) || !unrecognized.HasStatus,
		}
	}
	return Decision{
		SwitchToBackup: true,
		RetrySameModel: IsTransient(message),
	}
}

type fallbackModelFailure struct {
	Text     string
	Provider string
}
