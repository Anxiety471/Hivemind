// Package routes holds the gateway's per-procedure routing table.
//
// Slice 0 serves every procedure from the TypeScript API. The table exists so a
// later slice can move one procedure at a time, and a SIGHUP reload makes that
// cutover (or its rollback) a file edit rather than a deploy.
package routes

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"strings"
	"sync/atomic"
)

// Mode is what the gateway does with one procedure.
type Mode string

const (
	// Proxy forwards the request to the TypeScript API.
	Proxy Mode = "proxy"
	// Shadow answers from the TypeScript API and compares a Go implementation.
	Shadow Mode = "shadow"
	// Go answers from the Go implementation.
	Go Mode = "go"
)

// Route is one procedure's entry in the routing table.
type Route struct {
	Mode Mode `json:"mode"`
	// ReadOnly marks a procedure that performs no write. Shadow and
	// TypeScript fallback are only safe for these.
	ReadOnly bool `json:"readOnly"`
}

// Config is the shape of routes.json.
type Config struct {
	// Default applies to every procedure without an entry. Only proxy is valid
	// for now; an explicit entry is how a procedure moves to shadow or go.
	Default Mode             `json:"default"`
	Routes  map[string]Route `json:"routes"`
}

func defaultConfig() *Config {
	return &Config{Default: Proxy, Routes: map[string]Route{}}
}

// Store holds the current table and reloads it atomically.
type Store struct {
	path    string
	current atomic.Pointer[Config]
}

// NewStore returns a store for path. An empty path keeps the proxy-only default
// and makes Load/Reload no-ops.
func NewStore(path string) *Store {
	s := &Store{path: path}
	s.current.Store(defaultConfig())
	return s
}

// Load reads the table. A missing file is not an error: it means "proxy
// everything", which is the behaviour of a gateway with no routing table yet.
func (s *Store) Load() error {
	return s.reload()
}

// Reload reads the table again. On any error the previous table stays in use, so
// a bad edit cannot take traffic away from a working configuration.
func (s *Store) Reload() error {
	return s.reload()
}

func (s *Store) reload() error {
	if s.path == "" {
		return nil
	}
	data, err := os.ReadFile(s.path)
	if errors.Is(err, fs.ErrNotExist) {
		s.current.Store(defaultConfig())
		return nil
	}
	if err != nil {
		return fmt.Errorf("read routes %s: %w", s.path, err)
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	// A misspelt key must not silently fall back to proxy.
	decoder.DisallowUnknownFields()
	var config Config
	if err := decoder.Decode(&config); err != nil {
		return fmt.Errorf("parse routes %s: %w", s.path, err)
	}
	if err := validate(&config); err != nil {
		return fmt.Errorf("validate routes %s: %w", s.path, err)
	}
	s.current.Store(&config)
	return nil
}

func validate(config *Config) error {
	if config.Routes == nil {
		config.Routes = map[string]Route{}
	}
	if config.Default == "" {
		config.Default = Proxy
	}
	if config.Default != Proxy {
		return fmt.Errorf("default mode %q is not implemented by this build; every procedure defaults to proxy until it has an explicit entry", config.Default)
	}
	for name, route := range config.Routes {
		if name == "" {
			return errors.New("a route key cannot be empty")
		}
		if route.Mode == "" {
			route.Mode = Proxy
			config.Routes[name] = route
			continue
		}
		if !knownMode(route.Mode) {
			return fmt.Errorf("route %q has unknown mode %q", name, route.Mode)
		}
	}
	return nil
}

func knownMode(mode Mode) bool {
	return mode == Proxy || mode == Shadow || mode == Go
}

// ModeFor answers what to do with a request path.
func (s *Store) ModeFor(path string) Mode {
	config := s.current.Load()
	key := ProcedureKey(path)
	if route, ok := config.Routes[key]; ok {
		return route.Mode
	}
	return config.Default
}

// Len is the number of explicit entries, for health and logs.
func (s *Store) Len() int {
	return len(s.current.Load().Routes)
}

// ProcedureKey turns an oRPC URL path into the dotted name the table uses:
// /rpc/availability/set -> availability.set.
func ProcedureKey(path string) string {
	rest, ok := strings.CutPrefix(path, "/rpc/")
	if !ok {
		if path == "/rpc" || path == "/rpc/" {
			return ""
		}
		return ""
	}
	rest = strings.TrimSuffix(rest, "/")
	if rest == "" {
		return ""
	}
	parts := strings.Split(rest, "/")
	for i, part := range parts {
		if decoded, err := url.PathUnescape(part); err == nil {
			parts[i] = decoded
		}
	}
	return strings.Join(parts, ".")
}
