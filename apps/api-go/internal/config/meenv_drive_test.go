package config

import "testing"

func TestDriveURL(t *testing.T) {
	for in, want := range map[string]string{
		"https://drive.example.com":      "https://drive.example.com",
		" https://drive.example.com/ ":   "https://drive.example.com",
		"http://127.0.0.1:5173":          "http://127.0.0.1:5173",
		"http://192.168.1.4":             "http://192.168.1.4",
		"http://drive.example.com":       "",
		"https://drive.example.com/path": "",
		"https://u:p@drive.example.com":  "",
		"ftp://drive.example.com":        "",
		"":                               "",
	} {
		if got := driveURL(in); got != want {
			t.Errorf("driveURL(%q) = %q, want %q", in, got, want)
		}
	}
}
