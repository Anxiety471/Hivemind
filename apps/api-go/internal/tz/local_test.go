package tz

import (
	"archive/zip"
	"bytes"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestLoadIgnoresProcessZoneSources proves the lookup cannot fall back to the
// host: Go's time.LoadLocation would read ZONEINFO first and TZ. Both point at
// a different Havana here, and the embedded rule must still win.
func TestLoadIgnoresProcessZoneSources(t *testing.T) {
	wrong := zoneBytes(t, "Etc/GMT+12")
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "America"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "America", "Havana"), wrong, 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ZONEINFO", dir)
	t.Setenv("TZ", "America/Havana")

	location, err := Load("America/Havana")
	if err != nil {
		t.Fatal(err)
	}
	instant, err := time.Parse(time.RFC3339, "2026-11-10T07:46:43Z")
	if err != nil {
		t.Fatal(err)
	}
	if _, offset := instant.In(location).Zone(); offset != -5*3600 {
		t.Fatalf("America/Havana offset %+d: the lookup read a process zone source instead of the embedded release", offset)
	}
	// The host's zoneinfo 2026f has not ended Cuba's DST at this instant; if
	// the name reached time.LoadLocation the test would see -4h.
	if _, offset := instant.In(location).Zone(); offset == -4*3600 {
		t.Fatal("America/Havana still reads the host's 2026f rule")
	}
}

func zoneBytes(t *testing.T, name string) []byte {
	t.Helper()
	reader, err := zip.NewReader(bytes.NewReader(zoneinfoZip), int64(len(zoneinfoZip)))
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range reader.File {
		if file.Name != name {
			continue
		}
		opened, err := file.Open()
		if err != nil {
			t.Fatal(err)
		}
		defer opened.Close()
		var out bytes.Buffer
		if _, err := io.Copy(&out, opened); err != nil {
			t.Fatal(err)
		}
		return out.Bytes()
	}
	t.Fatalf("zoneinfo.zip lacks %q", name)
	return nil
}

// TestResolveLocalFollowsNodeSelection pins the fallback chain to what V8's
// Date does: TZ, else the zone /etc/localtime names, else UTC — with the rules
// always coming from the embedded release.
func TestResolveLocalFollowsNodeSelection(t *testing.T) {
	env := func(values map[string]string) func(string) string {
		return func(key string) string { return values[key] }
	}
	link := func(target string, err error) func(string) (string, error) {
		return func(string) (string, error) { return target, err }
	}
	none := func(string) (string, error) { return "", os.ErrNotExist }

	for _, c := range []struct {
		name  string
		get   func(string) string
		read  func(string) (string, error)
		want  string
		at    string
		shift int
	}{
		{"TZ wins", env(map[string]string{"TZ": "America/Havana"}), link("", os.ErrNotExist), "America/Havana", "2026-11-10T07:46:43Z", -5 * 3600},
		{"TZ may carry a leading colon", env(map[string]string{"TZ": ":Asia/Tokyo"}), none, "Asia/Tokyo", "2026-11-10T07:46:43Z", 9 * 3600},
		{"unknown TZ reads as UTC, like Intl", env(map[string]string{"TZ": "No/Such_Zone"}), none, "UTC", "2026-11-10T07:46:43Z", 0},
		{"localtime symlink", env(nil), link("/usr/share/zoneinfo/Asia/Manila", nil), "Asia/Manila", "2026-11-10T07:46:43Z", 8 * 3600},
		{"no TZ, no symlink", env(nil), none, "UTC", "2026-11-10T07:46:43Z", 0},
		{"a copied localtime file has no name", env(nil), link("/etc/localtime", nil), "UTC", "2026-11-10T07:46:43Z", 0},
	} {
		location := resolveLocal(c.get, c.read)
		if location.String() != c.want {
			t.Errorf("%s: %q, want %q", c.name, location.String(), c.want)
			continue
		}
		instant, err := time.Parse(time.RFC3339, c.at)
		if err != nil {
			t.Fatal(err)
		}
		if _, offset := instant.In(location).Zone(); offset != c.shift {
			t.Errorf("%s: offset %+d at %s, want %+d", c.name, offset, c.at, c.shift)
		}
	}
}
