// Package shared holds what the ported procedures have in common.
package shared

import (
	"errors"
	"time"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
)

// ISOMillis is Date.prototype.toISOString for a UTC instant.
const ISOMillis = "2006-01-02T15:04:05.000Z"

// ISO formats a database timestamp as toISOString does.
func ISO(at time.Time) string { return at.UTC().Format(ISOMillis) }

// NotFound is the IsolationError the API answers for a row outside the caller's Space.
var NotFound = orpc.NotFound("Resource not found")

// Failure turns an error out of a database call into the response the API gives:
// a failure raised on purpose as is, an unreachable database as 503, anything else 500.
func Failure(err error) *orpc.Error {
	var failure *orpc.Error
	if errors.As(err, &failure) {
		return failure
	}
	if db.IsUnavailable(err) {
		return orpc.Unavailable()
	}
	return orpc.Internal()
}

// OutputInvalid is the failure the router answers when a procedure's result breaks its
// contract schema (a stored value outside an enum, say): a 500 with its own message.
func OutputInvalid() *orpc.Error {
	return orpc.New("INTERNAL_SERVER_ERROR", 500, "Output validation failed")
}

// Deployment is the process configuration some procedures read: where links to the web
// app point, and whether the server sends email (which decides whether an invitee must
// have verified theirs before accepting).
type Deployment struct {
	WebOrigin     string
	EmailDelivery bool
}
