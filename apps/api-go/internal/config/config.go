// Package config reads the deployment environment the ported procedures need.
package config

import (
	"errors"
	"fmt"
	"math"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/contentcrypto"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/effects"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/local"
)

// Config is the process configuration.
type Config struct {
	DatabaseURL        string
	AuthSecret         []byte
	AuthURL            string
	WebOrigin          string
	APIURL             string
	ExtraOrigins       []string
	SignupAllowlist    []string
	OIDCBypass         bool
	CookieDomain       string
	MaxUploadBytes     int64
	MaxFileUploadBytes int64
	DataDir            string
	ObjectStorage      *ObjectStorageConfig
	Minimums           map[string]string
	TrustedOrigins     []string
	ClientIP           *effects.ClientIPResolver
	ClientIPHeader     string
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
	// ContentEncryption is CONTENT_ENCRYPTION (resolveContentEncryption): on seals new content,
	// off stores plaintext but still decrypts existing ciphertext.
	ContentEncryption bool
	// MasterKeys wrap each Space's data keys (ENCRYPTION_MASTER_KEYS first, then the key derived
	// from ENCRYPTION_KEY). Read at startup so a process that serves encrypted content cannot run
	// without material.
	MasterKeys []contentcrypto.MasterKey
	// BoardLab is TICKET_BOARD_ENABLED: the Labs board feature turned on for every account
	// (packages/adapters/src/labs-env.ts:4-11).
	BoardLab bool
	// PhoneCallsEnabled is PHONE_CALLS_ENABLED (phoneCallSettings, call-request.ts:5).
	PhoneCallsEnabled bool
	// PhoneCallRingSeconds is PHONE_CALL_RING_SECONDS: a positive Number(), else 45.
	PhoneCallRingSeconds float64
	// RedisURL is the optional REDIS_URL connection string for task queue dispatch,
	// retry scheduling, and stalled-bot bump coordination.
	RedisURL string
	// TaskBumpInterval controls how often the stalled-bot ticket sweeper runs (min 30s).
	TaskBumpInterval time.Duration
	// TaskBumpIdle is how long an open todo/doing ticket sits without updates before an idle worker bot is bumped.
	TaskBumpIdle time.Duration
	// TaskBumpCooldown is the minimum time between automatic bumps for the same ticket and bot.
	TaskBumpCooldown time.Duration
	// TaskQueueMaxAttempts caps delivery retries before a dispatch job moves to the dead-letter list.
	TaskQueueMaxAttempts int
	// DefaultModel is the deployment's main model (resolveDeploymentModel): what runs when a
	// member chose none, and whether its key or host credentials are present.
	DefaultModelProvider   string
	DefaultModel           string
	DefaultModelConfigured bool
	// ApprovalModel is the environment's Auto Review checker (resolveAutoReviewChecker), and
	// ApprovalModelConfigured is isAutoReviewCheckerConfigured({}).
	ApprovalModelProvider   string
	ApprovalModel           string
	ApprovalModelConfigured bool
	// DeploymentModelHostCredentials is resolveDeploymentModel's hostCredentials, and
	// DeploymentModelHostCredentialsUnknown is set when the TypeScript answer depends on
	// pi-ai's own environment table: `me` declines rather than guess.
	DeploymentModelHostCredentials        bool
	DeploymentModelHostCredentialsUnknown bool
	// MeEnv holds what `me` answers from beyond the model defaults: labs, menu links,
	// computer settings, admin emails, billing and upload limits (loadMeEnv).
	MeEnv meEnv
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
	config.CookieDomain = strings.TrimPrefix(strings.ToLower(strings.TrimSpace(os.Getenv("COOKIE_DOMAIN"))), ".")
	config.OIDCBypass = os.Getenv("OIDC_ALLOW_SIGNUP_BYPASS") == "true" && strings.TrimSpace(os.Getenv("OIDC_ISSUER")) != ""
	config.MaxUploadBytes = uploadBytes(os.Getenv("MAX_UPLOAD_SIZE_MB"))
	config.MaxFileUploadBytes = fileUploadBytes(os.Getenv("MAX_FILE_UPLOAD_SIZE_MB"), config.MaxUploadBytes)
	config.DataDir = strings.TrimSpace(os.Getenv("DATA_DIR"))
	if config.DataDir == "" {
		config.DataDir = "./data"
	}
	objectStorage, err := objectStorageFromEnv(os.Getenv)
	if err != nil {
		return Config{}, err
	}
	config.ObjectStorage = objectStorage
	config.EmailDelivery = emailDelivery(os.Getenv)
	config.InboundEmailDomain = strings.ToLower(strings.TrimSpace(os.Getenv("INBOUND_EMAIL_DOMAIN")))
	config.MaxComputersPerUser = strings.TrimSpace(os.Getenv("SANDBOX_MAX_COMPUTERS_PER_USER"))

	// A process that serves content reads these before listening: an unsupported key provider or
	// missing master keys must stop startup rather than turn every encrypted read into a 500
	// (apps/api/src/app.ts:296-301, packages/adapters/src/key-provider-factory.ts:24-42).
	if _, err := keyProviderName(os.Getenv); err != nil {
		return Config{}, err
	}
	encryption, err := contentEncryptionEnabled(os.Getenv)
	if err != nil {
		return Config{}, err
	}
	config.ContentEncryption = encryption
	keys, err := contentcrypto.MasterKeysFromEnv(os.Getenv)
	if err != nil {
		return Config{}, err
	}
	config.MasterKeys = keys
	config.BoardLab = os.Getenv("TICKET_BOARD_ENABLED") == "true"
	config.PhoneCallsEnabled = os.Getenv("PHONE_CALLS_ENABLED") == "true"
	config.PhoneCallRingSeconds = positiveNumber(os.Getenv("PHONE_CALL_RING_SECONDS"), 45)
	config.RedisURL = strings.TrimSpace(os.Getenv("REDIS_URL"))
	config.TaskBumpInterval = max(durationSeconds(os.Getenv("TASK_BUMP_INTERVAL_SEC"), 60), 30*time.Second)
	config.TaskBumpIdle = durationSeconds(os.Getenv("TASK_BUMP_IDLE_SEC"), 300)
	config.TaskBumpCooldown = durationSeconds(os.Getenv("TASK_BUMP_COOLDOWN_SEC"), 900)
	config.TaskQueueMaxAttempts = positiveInt(os.Getenv("TASK_QUEUE_MAX_ATTEMPTS"), 5)
	defaults := resolveModelDefaults(os.Getenv)
	config.DefaultModelProvider = defaults.provider
	config.DefaultModel = defaults.model
	config.DefaultModelConfigured = defaults.configured
	config.DeploymentModelHostCredentials = defaults.hostCredentials
	config.DeploymentModelHostCredentialsUnknown = defaults.hostCredentialsUnknown
	config.ApprovalModelProvider = defaults.approvalProvider
	config.ApprovalModel = defaults.approvalModel
	config.ApprovalModelConfigured = defaults.approvalConfigured
	config.MeEnv = loadMeEnv(os.LookupEnv)

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

// keyProviderName is the MASTER_KEY_PROVIDER check (packages/adapters/src/key-provider-factory.ts:24-42):
// empty and "local" wrap Space keys here; any other provider needs a key manager this build does not
// have, and a deployment that keeps one must not start and quietly wrap keys with the local master keys.
func keyProviderName(getenv func(string) string) (string, error) {
	provider := strings.TrimSpace(getenv("MASTER_KEY_PROVIDER"))
	switch provider {
	case "", "local":
		return "local", nil
	default:
		return "", fmt.Errorf(
			"MASTER_KEY_PROVIDER %q is not supported by this build: only \"local\" master keys unwrap Space keys",
			provider,
		)
	}
}

// contentEncryptionEnabled is resolveContentEncryption (packages/core/src/node/secrets-guard.ts:35-41):
// CONTENT_ENCRYPTION "on"/"off"; unset means on outside a development secret setup.
func contentEncryptionEnabled(getenv func(string) string) (bool, error) {
	switch strings.ToLower(strings.TrimSpace(getenv("CONTENT_ENCRYPTION"))) {
	case "on":
		return true, nil
	case "off":
		return false, nil
	case "":
		return getenv("NODE_ENV") != "development" && getenv("RAKAZO_ALLOW_DEV_SECRETS") != "1", nil
	default:
		return false, errors.New(`CONTENT_ENCRYPTION must be "on" or "off".`)
	}
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

// ObjectStorageConfig holds optional S3-compatible object storage settings.
type ObjectStorageConfig struct {
	Protocol        string
	Bucket          string
	Endpoint        string
	Region          string
	AccessKeyID     string
	SecretAccessKey string
	Prefix          string
	PathStyle       bool
}

func uploadBytes(raw string) int64 {
	if value, err := strconv.Atoi(strings.TrimSpace(raw)); err == nil && value > 0 {
		return int64(value) * 1024 * 1024
	}
	return 10 * 1024 * 1024
}

func fileUploadBytes(raw string, maxUploadBytes int64) int64 {
	const defaultBytes = 250 * 1024 * 1024
	const ceilingBytes = 2000 * 1024 * 1024
	if value, err := strconv.Atoi(strings.TrimSpace(raw)); err == nil && value > 0 {
		limit := int64(value) * 1024 * 1024
		if limit > ceilingBytes {
			return ceilingBytes
		}
		return limit
	}
	if maxUploadBytes > defaultBytes {
		if maxUploadBytes > ceilingBytes {
			return ceilingBytes
		}
		return maxUploadBytes
	}
	return defaultBytes
}

func objectStorageFromEnv(getenv func(string) string) (*ObjectStorageConfig, error) {
	bucket := strings.TrimSpace(getenv("OBJECT_STORAGE_BUCKET"))
	if bucket == "" {
		return nil, nil
	}
	protocol := strings.ToLower(strings.TrimSpace(getenv("OBJECT_STORAGE_PROTOCOL")))
	if protocol == "" {
		protocol = "s3"
	}
	if protocol != "s3" {
		return nil, fmt.Errorf(`OBJECT_STORAGE_PROTOCOL must be "s3"`)
	}
	accessKey := strings.TrimSpace(getenv("OBJECT_STORAGE_ACCESS_KEY_ID"))
	secretKey := strings.TrimSpace(getenv("OBJECT_STORAGE_SECRET_ACCESS_KEY"))
	if accessKey == "" || secretKey == "" {
		return nil, fmt.Errorf("OBJECT_STORAGE_ACCESS_KEY_ID and OBJECT_STORAGE_SECRET_ACCESS_KEY are required with OBJECT_STORAGE_BUCKET")
	}
	endpoint := strings.TrimSpace(getenv("OBJECT_STORAGE_ENDPOINT"))
	if endpoint != "" {
		parsed, err := url.Parse(endpoint)
		if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
			return nil, fmt.Errorf("OBJECT_STORAGE_ENDPOINT must be an http(s) URL")
		}
	}
	pathStyleRaw := strings.ToLower(strings.TrimSpace(getenv("OBJECT_STORAGE_PATH_STYLE")))
	if pathStyleRaw != "" && pathStyleRaw != "true" && pathStyleRaw != "false" {
		return nil, fmt.Errorf(`OBJECT_STORAGE_PATH_STYLE must be "true" or "false"`)
	}
	region := strings.TrimSpace(getenv("OBJECT_STORAGE_REGION"))
	if region == "" {
		region = "us-east-1"
	}
	prefix := strings.Trim(strings.TrimSpace(getenv("OBJECT_STORAGE_PREFIX")), "/")
	return &ObjectStorageConfig{
		Protocol:        protocol,
		Bucket:          bucket,
		Endpoint:        endpoint,
		Region:          region,
		AccessKeyID:     accessKey,
		SecretAccessKey: secretKey,
		Prefix:          prefix,
		PathStyle:       pathStyleRaw == "true",
	}, nil
}

func durationSeconds(raw string, fallbackSec int) time.Duration {
	if value, err := strconv.Atoi(strings.TrimSpace(raw)); err == nil && value > 0 {
		return time.Duration(value) * time.Second
	}
	return time.Duration(fallbackSec) * time.Second
}

func positiveInt(raw string, fallback int) int {
	if value, err := strconv.Atoi(strings.TrimSpace(raw)); err == nil && value > 0 {
		return value
	}
	return fallback
}

// positiveNumber is phoneCallSettings' `positive`: Number(value), kept when it is a finite
// number above zero, otherwise the fallback.
func positiveNumber(raw string, fallback float64) float64 {
	value, ok := numberValue(raw)
	if !ok || math.IsInf(value, 0) || math.IsNaN(value) || value <= 0 {
		return fallback
	}
	return value
}

// numberValue is Number(text) for the forms a deployment variable holds: decimal and
// exponent notation, hexadecimal/binary/octal prefixes, and Infinity.
func numberValue(raw string) (float64, bool) {
	text := strings.TrimSpace(raw)
	if text == "" {
		return 0, true
	}
	switch {
	case strings.HasPrefix(text, "0x") || strings.HasPrefix(text, "0X"):
		value, err := strconv.ParseUint(text[2:], 16, 64)
		return float64(value), err == nil
	case strings.HasPrefix(text, "0b") || strings.HasPrefix(text, "0B"):
		value, err := strconv.ParseUint(text[2:], 2, 64)
		return float64(value), err == nil
	case strings.HasPrefix(text, "0o") || strings.HasPrefix(text, "0O"):
		value, err := strconv.ParseUint(text[2:], 8, 64)
		return float64(value), err == nil
	}
	switch text {
	case "Infinity", "+Infinity":
		return math.Inf(1), true
	case "-Infinity":
		return math.Inf(-1), true
	}
	value, err := strconv.ParseFloat(text, 64)
	if err != nil {
		return 0, false
	}
	return value, true
}
