// Package orpc implements the small part of the oRPC wire protocol the ported
// procedures use: the {json, meta} envelope, the error envelope and statuses.
package orpc

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// Error is an ORPCError: the web client switches on Code and Status.
type Error struct {
	Code    string
	Status  int
	Message string
	// Data is the optional error payload; validation errors carry zod issues.
	Data any
}

func (e *Error) Error() string { return fmt.Sprintf("%s: %s", e.Code, e.Message) }

// Common constructors, matching @orpc/client's COMMON_ORPC_ERROR_DEFS.
func New(code string, status int, message string) *Error {
	return &Error{Code: code, Status: status, Message: message}
}

func BadRequest(message string) *Error { return New("BAD_REQUEST", 400, message) }

// InvalidInput is the shape the oRPC contract layer produces for a failed
// schema check: message plus the zod issues under data.
func InvalidInput(issues ...map[string]any) *Error {
	failure := New("BAD_REQUEST", 400, "Input validation failed")
	failure.Data = map[string]any{"issues": issues}
	return failure
}
func Unauthorized() *Error            { return New("UNAUTHORIZED", 401, "Unauthorized") }
func Forbidden(message string) *Error { return New("FORBIDDEN", 403, message) }
func NotFound(message string) *Error  { return New("NOT_FOUND", 404, message) }
func Conflict(message string) *Error  { return New("CONFLICT", 409, message) }
func TooLarge(message string) *Error  { return New("PAYLOAD_TOO_LARGE", 413, message) }
func Unavailable() *Error             { return New("SERVICE_UNAVAILABLE", 503, "Service Unavailable") }
func Internal() *Error {
	return New("INTERNAL_SERVER_ERROR", 500, "Internal server error")
}

// Marshal writes JSON exactly like JSON.stringify: no HTML escaping and no
// trailing newline.
func Marshal(value any) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buffer.Bytes(), []byte("\n")), nil
}

// WriteJSON writes a successful {json: value} reply.
func WriteJSON(w http.ResponseWriter, status int, value any) {
	body, err := Marshal(map[string]any{"json": value})
	if err != nil {
		WriteError(w, Internal())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

// WriteError writes the ORPC error envelope. The client requires exactly these
// keys and rejects extra ones.
func WriteError(w http.ResponseWriter, failure *Error) {
	envelope := map[string]any{
		"defined": false,
		"code":    failure.Code,
		"status":  failure.Status,
		"message": failure.Message,
	}
	if failure.Data != nil {
		envelope["data"] = failure.Data
	}
	body, err := Marshal(map[string]any{"json": envelope})
	if err != nil {
		body = []byte(`{"json":{"defined":false,"code":"INTERNAL_SERVER_ERROR","status":500,"message":"Internal server error"}}`)
		failure = Internal()
	}
	w.Header().Set("Content-Type", "application/json")
	if failure.Status == http.StatusServiceUnavailable {
		w.Header().Set("Retry-After", "5")
	}
	w.WriteHeader(failure.Status)
	_, _ = w.Write(body)
}

// Input is one decoded request envelope.
type Input struct {
	// Raw is the value under "json"; nil when the body was empty.
	Raw json.RawMessage
}

// HasInput reports whether the caller sent a value (rather than an empty body).
func (i Input) HasInput() bool {
	return len(i.Raw) > 0 && string(i.Raw) != "null"
}

// DecodeInput reads the request body up to limit and unwraps the envelope.
func DecodeInput(r *http.Request, limit int64) (Input, *Error) {
	if r.ContentLength > limit && !chunked(r) {
		return Input{}, TooLarge("Request body is too large.")
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, limit+1))
	if err != nil {
		return Input{}, BadRequest("Malformed request.")
	}
	if int64(len(body)) > limit {
		return Input{}, TooLarge("Request body is too large.")
	}
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 {
		return Input{}, nil
	}
	var envelope struct {
		JSON json.RawMessage `json:"json"`
		Meta json.RawMessage `json:"meta"`
	}
	if err := json.Unmarshal(trimmed, &envelope); err != nil {
		return Input{}, BadRequest("Malformed request. Ensure the request body is properly formatted and the 'Content-Type' header is set correctly.")
	}
	if len(envelope.Meta) > 0 && string(bytes.TrimSpace(envelope.Meta)) != "null" {
		return Input{}, BadRequest("Unsupported meta encoding.")
	}
	return Input{Raw: envelope.JSON}, nil
}

// DecodeInto decodes the input value into target. A missing value is a bad
// request because every ported input is a required object.
func (i Input) DecodeInto(target any) *Error {
	if !i.HasInput() {
		return BadRequest("Input validation failed: missing input")
	}
	if err := json.Unmarshal(i.Raw, target); err != nil {
		return BadRequest("Input validation failed: " + strings.SplitN(err.Error(), "\n", 2)[0])
	}
	return nil
}

func chunked(r *http.Request) bool {
	return len(r.TransferEncoding) > 0 && r.TransferEncoding[0] == "chunked"
}
