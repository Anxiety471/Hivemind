package filepolicy

import (
	"testing"
)

func TestInferMIMEBroadenedTypesAndBlockedExecutables(t *testing.T) {
	cases := []struct {
		name     string
		reported string
		want     string
		wantErr  bool
	}{
		{"deploy.sh", "text/plain", "application/x-sh", false},
		{"setup.SH", "", "application/x-sh", false},
		{"demo.mp4", "video/mp4", "video/mp4", false},
		{"clip.mov", "video/x-quicktime", "video/quicktime", false},
		{"bundle.tar.gz", "application/octet-stream", "application/gzip", false},
		{"analysis.py", "text/plain", "text/x-python", false},
		{"notes.csv", "application/vnd.ms-excel", "text/csv", false},
		{"voice.m4a", "audio/aac", "audio/mp4", false},
		{"firmware.bin", "", "application/octet-stream", false},
		{"blob.unknown", "application/x-custom", "application/octet-stream", false},
		{"malware.exe", "", "", true},
		{"Installer.MSI", "application/octet-stream", "", true},
		{"anything.dat", "application/x-msdownload", "", true},
		{"bad", "not-a-mime", "", true},
	}

	for _, c := range cases {
		got, err := InferMIME(c.name, c.reported)
		if c.wantErr {
			if err == nil || !IsValidationError(err) {
				t.Errorf("InferMIME(%q, %q) expected ValidationError, got (%q, %v)", c.name, c.reported, got, err)
			}
			continue
		}
		if err != nil || got != c.want {
			t.Errorf("InferMIME(%q, %q) = (%q, %v), want %q", c.name, c.reported, got, err, c.want)
		}
	}
}

func TestSniffSafeUploadAndInlineDisposition(t *testing.T) {
	if err := SniffSafeUpload("image/png", []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a, 0x00}); err != nil {
		t.Fatalf("valid png failed: %v", err)
	}
	if err := SniffSafeUpload("image/png", []byte("<svg><script>alert(1)</script></svg>")); err == nil {
		t.Fatal("spoofed png with svg rejected expected")
	}
	if err := SniffSafeUpload("video/mp4", []byte("<!DOCTYPE html><html></html>")); err == nil {
		t.Fatal("html masquerading as mp4 should fail")
	}
	if err := SniffSafeUpload("application/x-sh", []byte("#!/usr/bin/env bash\necho ok\n")); err != nil {
		t.Fatalf("valid sh script failed: %v", err)
	}
	if IsSafeInlineMedia("text/html") || IsSafeInlineMedia("image/svg+xml") || IsSafeInlineMedia("application/x-sh") {
		t.Fatal("active html/svg/sh must not be inline-safe on credentialed origin")
	}
	if !IsSafeInlineMedia("video/mp4") || !IsSafeInlineMedia("image/png") || !IsSafeInlineMedia("application/pdf") {
		t.Fatal("media types and pdf should allow inline disposition")
	}
	if _, err := ValidateDriveName("../secret"); err == nil {
		t.Fatal("expected traversal name rejection")
	}
	if got, err := ValidateDriveName("  run.sh  "); err != nil || got != "run.sh" {
		t.Fatalf("ValidateDriveName = (%q, %v)", got, err)
	}
	if got := CategoryForMIME("application/x-sh"); got != "code" {
		t.Fatalf("category = %q, want code", got)
	}
	if got := CategoryForMIME("video/mp4"); got != "video" {
		t.Fatalf("category = %q, want video", got)
	}
}

func TestSlugAndFolderNameHelpers(t *testing.T) {
	if got, err := NormalizeSlug("  Q3_Board Deck v2!! "); err != nil || got != "q3-board-deck-v2" {
		t.Fatalf("NormalizeSlug = (%q, %v), want q3-board-deck-v2", got, err)
	}
	if _, err := NormalizeSlug("   ---   "); err == nil {
		t.Fatal("expected empty/punctuation slug to fail")
	}
	if got := SlugifyFilename("Quarterly_Report 2026.pdf"); got != "quarterly-report-2026" {
		t.Fatalf("SlugifyFilename = %q, want quarterly-report-2026", got)
	}
	if got := SlugifyFilename("???.bin"); got != "file" {
		t.Fatalf("SlugifyFilename fallback = %q, want file", got)
	}
	if got := SanitizeFolderName("  Research / Ops Bot \n ", "Bot"); got != "Research Ops Bot" {
		t.Fatalf("SanitizeFolderName = %q", got)
	}
	if got := SanitizeFolderName("..", "Bot"); got != "Bot" {
		t.Fatalf("SanitizeFolderName dotdot = %q, want Bot", got)
	}
}
