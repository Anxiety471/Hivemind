package routes

import (
	"os"
	"path/filepath"
	"testing"
)

func TestProcedureKey(t *testing.T) {
	cases := map[string]string{
		"/rpc/me":                         "me",
		"/rpc/health":                     "health",
		"/rpc/availability/set":           "availability.set",
		"/rpc/organizations/members/list": "organizations.members.list",
		"/rpc/threads/subscribe/":         "threads.subscribe",
		"/rpc":                            "",
		"/rpc/":                           "",
		"/other":                          "",
	}
	for path, want := range cases {
		if got := ProcedureKey(path); got != want {
			t.Errorf("ProcedureKey(%q) = %q, want %q", path, got, want)
		}
	}
}

func TestModeForDefaultsToProxy(t *testing.T) {
	store := NewStore("")
	if err := store.Load(); err != nil {
		t.Fatalf("load: %v", err)
	}
	if got := store.ModeFor("/rpc/anything"); got != Proxy {
		t.Errorf("mode = %q, want proxy", got)
	}
}

func TestReloadSwapsTable(t *testing.T) {
	path := filepath.Join(t.TempDir(), "routes.json")
	if err := os.WriteFile(path, []byte(`{"default":"proxy","routes":{"me":{"mode":"go","readOnly":true}}}`), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	store := NewStore(path)
	if err := store.Load(); err != nil {
		t.Fatalf("load: %v", err)
	}
	if got := store.ModeFor("/rpc/me"); got != Go {
		t.Fatalf("mode = %q, want go", got)
	}
	if got := store.ModeFor("/rpc/health"); got != Proxy {
		t.Errorf("mode = %q, want proxy", got)
	}

	if err := os.WriteFile(path, []byte(`{"default":"proxy","routes":{"me":{"mode":"proxy"}}}`), 0o600); err != nil {
		t.Fatalf("rewrite: %v", err)
	}
	if err := store.Reload(); err != nil {
		t.Fatalf("reload: %v", err)
	}
	if got := store.ModeFor("/rpc/me"); got != Proxy {
		t.Errorf("mode after reload = %q, want proxy", got)
	}
}

func TestInvalidReloadKeepsPreviousTable(t *testing.T) {
	path := filepath.Join(t.TempDir(), "routes.json")
	if err := os.WriteFile(path, []byte(`{"default":"proxy","routes":{"me":{"mode":"go"}}}`), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	store := NewStore(path)
	if err := store.Load(); err != nil {
		t.Fatalf("load: %v", err)
	}
	for _, broken := range []string{
		`{"default":"go"}`,
		`{"routes":{"me":{"mode":"nonsense"}}}`,
		`{"routes":{"me":{"mode":"go","mystery":true}}}`,
		`not json`,
	} {
		if err := os.WriteFile(path, []byte(broken), 0o600); err != nil {
			t.Fatalf("write broken: %v", err)
		}
		if err := store.Reload(); err == nil {
			t.Fatalf("reload(%s) succeeded, want an error", broken)
		}
		if got := store.ModeFor("/rpc/me"); got != Go {
			t.Fatalf("previous table lost after %s: mode = %q", broken, got)
		}
	}
}

func TestMissingFileMeansProxyEverything(t *testing.T) {
	store := NewStore(filepath.Join(t.TempDir(), "absent.json"))
	if err := store.Load(); err != nil {
		t.Fatalf("load: %v", err)
	}
	if got := store.ModeFor("/rpc/me"); got != Proxy {
		t.Errorf("mode = %q, want proxy", got)
	}
}

func TestEmptyRouteModeIsProxy(t *testing.T) {
	path := filepath.Join(t.TempDir(), "routes.json")
	if err := os.WriteFile(path, []byte(`{"routes":{"me":{}}}`), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	store := NewStore(path)
	if err := store.Load(); err != nil {
		t.Fatalf("load: %v", err)
	}
	if got := store.ModeFor("/rpc/me"); got != Proxy {
		t.Errorf("mode = %q, want proxy", got)
	}
}
