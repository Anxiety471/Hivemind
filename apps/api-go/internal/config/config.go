// Package config reads the deployment environment the ported procedures need.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"

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
	return config, nil
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
