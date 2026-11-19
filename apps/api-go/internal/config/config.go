// Package config reads the deployment environment the ported procedures need.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/effects"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/local"
)

// Config is the process configuration.
type Config struct {
	DatabaseURL     string
	AuthSecret      []byte
	AuthURL         string
	WebOrigin       string
	APIURL          string
	ExtraOrigins    []string
	SignupAllowlist []string
	OIDCBypass      bool
	MaxUploadBytes  int64
	Minimums        map[string]string
	TrustedOrigins  []string
	ClientIP        *effects.ClientIPResolver
	ClientIPHeader  string
	// EmailDelivery is whether the API sends email, which TypeScript derives from the same
	// variables (configuredEmailProvider, or the development emulator): an invitee must then
	// have verified their address.
	EmailDelivery bool
	// InboundEmailDomain is env.inboundEmail.domain for bots.emailAddress*: the lowercased
	// INBOUND_EMAIL_DOMAIN, empty when the server receives no email.
	InboundEmailDomain string
	// MaxComputersPerUser is the raw SANDBOX_MAX_COMPUTERS_PER_USER the restore procedures
	// resolve per call.
	MaxComputersPerUser string
}

// Load reads the environment. Only a build that serves procedures needs the
// secrets, so a proxy-only gateway starts without them.
func Load() (Config, error) {
	config := Config{
		DatabaseURL: strings.TrimSpace(os.Getenv("DATABASE_URL")),
		AuthURL:     strings.TrimSpace(os.Getenv("BETTER_AUTH_URL")),
		WebOrigin:   strings.TrimSpace(os.Getenv("WEB_ORIGIN")),
		APIURL:      strings.TrimSpace(os.Getenv("API_URL")),
	}
	if config.DatabaseURL == "" {
		return Config{}, fmt.Errorf("DATABASE_URL is required to serve procedures")
	}
	secret := os.Getenv("BETTER_AUTH_SECRET")
	if strings.TrimSpace(secret) == "" {
		return Config{}, fmt.Errorf("BETTER_AUTH_SECRET is required to serve procedures")
	}
	config.AuthSecret = []byte(secret)
	if config.WebOrigin == "" {
		return Config{}, fmt.Errorf("WEB_ORIGIN is required to serve procedures")
	}
	if config.AuthURL == "" {
		config.AuthURL = config.WebOrigin
	}
	if config.APIURL == "" {
		config.APIURL = "http://127.0.0.1:3100"
	}
	config.ExtraOrigins = splitList(os.Getenv("RAKAZO_EXTRA_AUTH_ORIGINS"))
	config.SignupAllowlist = splitList(os.Getenv("SIGNUP_ALLOWLIST"))
	config.OIDCBypass = os.Getenv("OIDC_ALLOW_SIGNUP_BYPASS") == "true" && strings.TrimSpace(os.Getenv("OIDC_ISSUER")) != ""
	config.MaxUploadBytes = uploadBytes(os.Getenv("MAX_UPLOAD_SIZE_MB"))
	config.EmailDelivery = emailDelivery(os.Getenv)
	config.InboundEmailDomain = strings.ToLower(strings.TrimSpace(os.Getenv("INBOUND_EMAIL_DOMAIN")))
	config.MaxComputersPerUser = strings.TrimSpace(os.Getenv("SANDBOX_MAX_COMPUTERS_PER_USER"))

	minimums, err := local.ParseMinimums(os.Getenv("RAKAZO_MIN_CLIENT_BUILD"))
	if err != nil {
		return Config{}, err
	}
	config.Minimums = minimums

	origins := []string{config.WebOrigin, config.APIURL, config.AuthURL}
	origins = append(origins, config.ExtraOrigins...)
	// The native clients' app scheme and Expo web dev servers, as the API trusts them.
	origins = append(origins,
		"rakazo://",
		"http://localhost:8081",
		"http://127.0.0.1:8081",
		"http://localhost:19006",
		"http://127.0.0.1:19006",
	)
	config.TrustedOrigins = origins

	// Built before anything listens, so a bad TRUSTED_PROXIES entry stops startup.
	trusted := effects.ParseTrustedProxies(os.Getenv("TRUSTED_PROXIES"))
	if len(trusted) == 0 {
		trusted = effects.DefaultTrustedProxies()
	}
	resolver, err := effects.NewClientIPResolver(trusted)
	if err != nil {
		return Config{}, err
	}
	config.ClientIP = resolver
	config.ClientIPHeader = strings.ToLower(strings.TrimSpace(os.Getenv("CLIENT_IP_HEADER")))
	if config.ClientIPHeader == "" {
		config.ClientIPHeader = "x-forwarded-for"
	}
	return config, nil
}

// emailDelivery is `Boolean(deps.email)` (apps/api/src/app.ts:422-434): a provider chosen by
// EMAIL_PROVIDER (SMTP_URL alone chooses smtp, as packages/adapters/src/email-provider.ts:18
// does), or the emulator outside production. TypeScript refuses to start for a provider it
// does not know, so any value but "none" counts as configured: the stricter reading.
func emailDelivery(getenv func(string) string) bool {
	provider := strings.TrimSpace(getenv("EMAIL_PROVIDER"))
	if provider == "" {
		if strings.TrimSpace(getenv("SMTP_URL")) != "" {
			provider = "smtp"
		} else {
			provider = "none"
		}
	}
	if provider != "none" {
		return true
	}
	return getenv("EMAIL_EMULATOR") == "true" && getenv("NODE_ENV") != "production"
}

func splitList(raw string) []string {
	var values []string
	for _, entry := range strings.Split(raw, ",") {
		if entry = strings.TrimSpace(entry); entry != "" {
			values = append(values, entry)
		}
	}
	return values
}

func uploadBytes(raw string) int64 {
	if value, err := strconv.Atoi(strings.TrimSpace(raw)); err == nil && value > 0 {
		return int64(value) * 1024 * 1024
	}
	return 10 * 1024 * 1024
}
