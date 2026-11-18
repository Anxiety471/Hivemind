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
