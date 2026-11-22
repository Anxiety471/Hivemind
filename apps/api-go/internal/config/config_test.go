package config

import "testing"

func TestEmailDeliveryFollowsTheProviderSettings(t *testing.T) {
	cases := []struct {
		name string
		env  map[string]string
		want bool
	}{
		{"nothing set", map[string]string{}, false},
		{"explicit none", map[string]string{"EMAIL_PROVIDER": "none"}, false},
		{"smtp url alone chooses smtp", map[string]string{"SMTP_URL": "smtp://mail.example:587"}, true},
		{"smtp url with none stays off", map[string]string{"EMAIL_PROVIDER": "none", "SMTP_URL": "smtp://mail.example:587"}, false},
		{"resend", map[string]string{"EMAIL_PROVIDER": "resend", "EMAIL_API_KEY": "k"}, true},
		{"unknown provider is the stricter reading", map[string]string{"EMAIL_PROVIDER": "pigeon"}, true},
		{"blank values are unset", map[string]string{"EMAIL_PROVIDER": "  ", "SMTP_URL": " "}, false},
		{"emulator outside production", map[string]string{"EMAIL_EMULATOR": "true", "NODE_ENV": "development"}, true},
		{"emulator unset node env", map[string]string{"EMAIL_EMULATOR": "true"}, true},
		{"emulator is ignored in production", map[string]string{"EMAIL_EMULATOR": "true", "NODE_ENV": "production"}, false},
		{"emulator needs exactly true", map[string]string{"EMAIL_EMULATOR": "1"}, false},
	}
	for _, c := range cases {
		got := emailDelivery(func(key string) string { return c.env[key] })
		if got != c.want {
			t.Errorf("%s: emailDelivery = %t, want %t", c.name, got, c.want)
		}
	}
}

func TestContentEncryptionFollowsTheSetting(t *testing.T) {
	cases := []struct {
		name string
		env  map[string]string
		want bool
	}{
		{"explicitly on", map[string]string{"CONTENT_ENCRYPTION": "on"}, true},
		{"explicitly off", map[string]string{"CONTENT_ENCRYPTION": "off"}, false},
		{"case and spaces are trimmed", map[string]string{"CONTENT_ENCRYPTION": " On "}, true},
		{"unset is on outside development", map[string]string{}, true},
		{"unset is on in tests", map[string]string{"NODE_ENV": "test"}, true},
		{"unset is off in development", map[string]string{"NODE_ENV": "development"}, false},
		{"unset is off with dev secrets allowed", map[string]string{"RAKAZO_ALLOW_DEV_SECRETS": "1"}, false},
		{"anything else is refused", map[string]string{"CONTENT_ENCRYPTION": "yes"}, false},
	}
	for _, c := range cases {
		got, err := contentEncryptionEnabled(func(key string) string { return c.env[key] })
		if c.name == "anything else is refused" {
			if err == nil {
				t.Errorf("%s: contentEncryptionEnabled accepted it", c.name)
			}
			continue
		}
		if err != nil || got != c.want {
			t.Errorf("%s: contentEncryptionEnabled = %t, %v, want %t", c.name, got, err, c.want)
		}
	}
}

func TestUnsupportedMasterKeyProviderStopsStartup(t *testing.T) {
	for _, provider := range []string{"aws-kms", "Local", "kms"} {
		if _, err := keyProviderName(func(key string) string {
			if key == "MASTER_KEY_PROVIDER" {
				return provider
			}
			return ""
		}); err == nil {
			t.Errorf("MASTER_KEY_PROVIDER %q must be refused", provider)
		}
	}
	for _, provider := range []string{"", "local", " local "} {
		if name, err := keyProviderName(func(key string) string {
			if key == "MASTER_KEY_PROVIDER" {
				return provider
			}
			return ""
		}); err != nil || name != "local" {
			t.Errorf("MASTER_KEY_PROVIDER %q: keyProviderName = %q, %v", provider, name, err)
		}
	}
}

func TestFileUploadBytesAndObjectStorageFromEnv(t *testing.T) {
	if got := fileUploadBytes("", 10*1024*1024); got != 250*1024*1024 {
		t.Errorf("default fileUploadBytes = %d", got)
	}
	if got := fileUploadBytes("", 500*1024*1024); got != 500*1024*1024 {
		t.Errorf("inherited larger upload bytes = %d", got)
	}
	if got := fileUploadBytes("4096", 10*1024*1024); got != 2000*1024*1024 {
		t.Errorf("capped fileUploadBytes = %d", got)
	}

	if cfg, err := objectStorageFromEnv(func(string) string { return "" }); err != nil || cfg != nil {
		t.Errorf("empty bucket should yield nil, nil; got %+v, %v", cfg, err)
	}
	if _, err := objectStorageFromEnv(func(k string) string {
		if k == "OBJECT_STORAGE_BUCKET" {
			return "b"
		}
		return ""
	}); err == nil {
		t.Error("expected error when credentials are missing")
	}
	if _, err := objectStorageFromEnv(func(k string) string {
		return map[string]string{
			"OBJECT_STORAGE_BUCKET":            "b",
			"OBJECT_STORAGE_ACCESS_KEY_ID":     "ak",
			"OBJECT_STORAGE_SECRET_ACCESS_KEY": "sk",
			"OBJECT_STORAGE_ENDPOINT":          "ftp://bad",
		}[k]
	}); err == nil {
		t.Error("expected error for non-http endpoint")
	}
	cfg, err := objectStorageFromEnv(func(k string) string {
		return map[string]string{
			"OBJECT_STORAGE_BUCKET":            "my-bucket",
			"OBJECT_STORAGE_ACCESS_KEY_ID":     "ak",
			"OBJECT_STORAGE_SECRET_ACCESS_KEY": "sk",
			"OBJECT_STORAGE_ENDPOINT":          "https://s3.internal:9000",
			"OBJECT_STORAGE_PREFIX":            "/prod/files/",
			"OBJECT_STORAGE_PATH_STYLE":        "true",
		}[k]
	})
	if err != nil || cfg == nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Prefix != "prod/files" || !cfg.PathStyle || cfg.Region != "us-east-1" {
		t.Errorf("unexpected parsed config: %+v", cfg)
	}
}
