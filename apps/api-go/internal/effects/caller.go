package effects

import "context"

// Caller is what a security event records about the request: the resolved
// client address and user agent (withSecurityRequest in TypeScript).
type Caller struct {
	IP        string
	UserAgent string
}

type callerKey struct{}

// WithCaller makes the caller available to events recorded within ctx.
func WithCaller(ctx context.Context, caller Caller) context.Context {
	return context.WithValue(ctx, callerKey{}, caller)
}

// CallerFrom returns the caller recorded on ctx.
func CallerFrom(ctx context.Context) (Caller, bool) {
	caller, ok := ctx.Value(callerKey{}).(Caller)
	return caller, ok
}
