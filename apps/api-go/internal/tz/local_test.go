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

// TestResolveLocalFollowsV8 pins the default-zone rules to production V8's
// measured behaviour (Node 24.22.3, one process per TZ value): TZ when set is an
// exact zone id, a TZif path, or a plain POSIX standard-time offset; a DST POSIX
// string falls back to the system zone; case variants and unknown names read as
// UTC; unset reads the zone /etc/localtime names; an empty TZ is UTC.
func TestResolveLocalFollowsV8(t *testing.T) {
	const (
		manilaLink = "/usr/share/zoneinfo/Asia/Manila"
		summer     = "2026-07-15T12:00:00Z"
		winter     = "2026-12-06T12:00:00Z"
	)
	env := func(values map[string]string) func(string) (string, bool) {
		return func(key string) (string, bool) { value, ok := values[key]; return value, ok }
	}
	link := func(target string, err error) func(string) (string, error) {
		return func(string) (string, error) { return target, err }
	}
	none := func(string) (string, error) { return "", os.ErrNotExist }
	noFile := func(string) ([]byte, error) { return nil, os.ErrNotExist }
	manual := link(manilaLink, nil)

	for _, c := range []struct {
		name   string
		getenv func(string) (string, bool)
		read   func(string) (string, error)
		file   func(string) ([]byte, error)
		want   string
		summer int
		winter int
	}{
		{"unset reads the localtime zone", env(nil), manual, noFile, "Asia/Manila", 8 * 3600, 8 * 3600},
		{"unset with no localtime reads UTC", env(nil), none, noFile, "UTC", 0, 0},
		{"empty TZ is UTC", env(map[string]string{"TZ": ""}), manual, noFile, "UTC", 0, 0},
		{"a lone colon is UTC", env(map[string]string{"TZ": ":"}), manual, noFile, "UTC", 0, 0},
		{"localtime means the system zone", env(map[string]string{"TZ": "localtime"}), manual, noFile, "Asia/Manila", 8 * 3600, 8 * 3600},
		{"exact id", env(map[string]string{"TZ": "Asia/Tokyo"}), manual, noFile, "Asia/Tokyo", 9 * 3600, 9 * 3600},
		{"colon-prefixed id", env(map[string]string{"TZ": ":Asia/Tokyo"}), manual, noFile, "Asia/Tokyo", 9 * 3600, 9 * 3600},
		{"lowercase id is not the default zone", env(map[string]string{"TZ": "asia/tokyo"}), manual, noFile, "UTC", 0, 0},
		{"an ICU alias resolves", env(map[string]string{"TZ": "US/Pacific-New"}), manual, noFile, "US/Pacific-New", -7 * 3600, -8 * 3600},
		{"an ICU alias with history resolves", env(map[string]string{"TZ": "Canada/East-Saskatchewan"}), manual, noFile, "Canada/East-Saskatchewan", -6 * 3600, -6 * 3600},
		{"a System V id reads as UTC in V8's default-zone path", env(map[string]string{"TZ": "PST"}), manual, noFile, "UTC", 0, 0},
		{"another System V id", env(map[string]string{"TZ": "ACT"}), manual, noFile, "UTC", 0, 0},
		{"a legacy link reads UTC", env(map[string]string{"TZ": "Cuba"}), manual, noFile, "UTC", 0, 0},
		{"another legacy link reads UTC", env(map[string]string{"TZ": "PRC"}), manual, noFile, "UTC", 0, 0},
		{"a legacy link with DST reads UTC", env(map[string]string{"TZ": "Iran"}), manual, noFile, "UTC", 0, 0},
		{"a case variant the zip does not carry reads UTC", env(map[string]string{"TZ": "CUBA"}), manual, noFile, "UTC", 0, 0},
		{"a synthesized fixed System V zone loads", env(map[string]string{"TZ": "SystemV/AST4"}), manual, noFile, "SystemV/AST4", -4 * 3600, -4 * 3600},
		{"another synthesized fixed zone", env(map[string]string{"TZ": "SystemV/HST10"}), manual, noFile, "SystemV/HST10", -10 * 3600, -10 * 3600},
		{"a synthesized DST System V zone falls back", env(map[string]string{"TZ": "SystemV/EST5EDT"}), manual, noFile, "Asia/Manila", 8 * 3600, 8 * 3600},
		{"another synthesized DST zone falls back", env(map[string]string{"TZ": "SystemV/YST9YDT"}), manual, noFile, "Asia/Manila", 8 * 3600, 8 * 3600},
		{"a fixed POSIX zone", env(map[string]string{"TZ": "ABC3"}), manual, noFile, "ABC3", -3 * 3600, -3 * 3600},
		{"a fixed POSIX zone east", env(map[string]string{"TZ": "XXX-3"}), manual, noFile, "XXX-3", 3 * 3600, 3 * 3600},
		{"POSIX UTC", env(map[string]string{"TZ": "UTC0"}), manual, noFile, "UTC0", 0, 0},
		{"a POSIX zone with DST falls back to the system zone", env(map[string]string{"TZ": "ABC3DEF,M3.2.0/2,M11.1.0/2"}), manual, noFile, "Asia/Manila", 8 * 3600, 8 * 3600},
		{"a POSIX zone with a minute offset falls back", env(map[string]string{"TZ": "ABC3:30"}), manual, noFile, "Asia/Manila", 8 * 3600, 8 * 3600},
		{"an angle-bracketed POSIX zone falls back", env(map[string]string{"TZ": "<-03>3"}), manual, noFile, "Asia/Manila", 8 * 3600, 8 * 3600},
		{"a short POSIX name with an offset is UTC", env(map[string]string{"TZ": "A3"}), manual, noFile, "UTC", 0, 0},
		{"letters without an offset are not POSIX", env(map[string]string{"TZ": "ABC"}), manual, noFile, "UTC", 0, 0},
		{"an unknown name is UTC", env(map[string]string{"TZ": "No/Such"}), manual, noFile, "UTC", 0, 0},
		{"a space is not trimmed", env(map[string]string{"TZ": " GMT"}), manual, noFile, "UTC", 0, 0},
		{"Factory is UTC", env(map[string]string{"TZ": "Factory"}), manual, noFile, "Factory", 0, 0},
		{"a missing TZif path is UTC", env(map[string]string{"TZ": "/no/such/file"}), manual, noFile, "UTC", 0, 0},
		{"a relative path is read", env(map[string]string{"TZ": "./tzone"}), manual, func(string) ([]byte, error) {
			return zoneBytes(t, "Asia/Tokyo"), nil
		}, "./tzone", 9 * 3600, 9 * 3600},
		{"an absolute TZif path is read", env(map[string]string{"TZ": "/usr/share/zoneinfo/Asia/Tokyo"}), manual, func(string) ([]byte, error) {
			return zoneBytes(t, "Asia/Tokyo"), nil
		}, "/usr/share/zoneinfo/Asia/Tokyo", 9 * 3600, 9 * 3600},
	} {
		location := resolveLocal(c.getenv, c.read, c.file)
		if location.String() != c.want {
			t.Errorf("%s: zone %q, want %q", c.name, location.String(), c.want)
			continue
		}
		for at, want := range map[string]int{summer: c.summer, winter: c.winter} {
			instant, err := time.Parse(time.RFC3339, at)
			if err != nil {
				t.Fatal(err)
			}
			if _, offset := instant.In(location).Zone(); offset != want {
				t.Errorf("%s at %s: offset %+d, want %+d", c.name, at, offset, want)
			}
		}
	}
}
