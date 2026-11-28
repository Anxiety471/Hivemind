package config

import (
	"encoding/json"
	"errors"
	"net/netip"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

// NavLink is NavLinkSchema (packages/contracts/src/clients/nav-links.ts:22): one
// operator-configured menu link RAKAZO_NAV_LINKS declares. `trusted` is the schema's
// default (false) when the operator leaves it out.
type NavLink struct {
	ID      string `json:"id"`
	Label   string `json:"label"`
	Path    string `json:"path"`
	Trusted bool   `json:"trusted"`
}

// meEnv is the deployment configuration `me` answers from beyond the model defaults:
// what env.ts (apps/api/src/env.ts) reads for the same fields on the TypeScript side.
type meEnv struct {
	NavLinks        []NavLink
	NavLinksUnknown bool
	// DriveURL is env.driveUrl: the origin of the Drive app, from DRIVE_URL.
	DriveURL                 string
	ComputerSettingsEnabled  bool
	DesktopHostChoiceEnabled bool
	// SandboxProvider is resolveSandboxProvider (packages/adapters/src/computers/sandbox/
	// sandbox-provider-env.ts:9): the provider this deployment runs computers on.
	SandboxProvider string
	// AgentRuntime is env.agentRuntime: AGENT_RUNTIME as given, "pi" when unset.
	AgentRuntime string
	// McpStdioAllowed is mcpStdioAvailable's second half: an allowlist is configured.
	McpStdioEnabled         bool
	McpStdioAllowedCommands []string
	// MaxAttachmentsPerMessage is attachmentCountFromEnv (packages/core/src/messages/
	// attachments.ts:33). Invalid values stop the TypeScript server at startup; the Go
	// side serves no `me` then and declines to it.
	MaxAttachmentsPerMessage int
	AttachmentsUnknown       bool
	// AdminEmails is env.adminEmails: RAKAZO_ADMIN_EMAILS, lowercased.
	AdminEmails []string
	// BillingConfigured is Boolean(env.billing): Stripe's secrets, or the emulator outside
	// production (apps/api/src/app.ts:452-462).
	BillingConfigured bool
	// PaymentWalletProvider is resolvePaymentWalletProvider: "link", "emulator" or "none".
	PaymentWalletProvider string
}

// loadMeEnv reads the variables apps/api/src/env.ts reads for the `me` fields, using
// lookup so an unset variable differs from an empty one where the TypeScript does
// (`AGENT_RUNTIME ?? "pi"`).
func loadMeEnv(lookup func(string) (string, bool)) meEnv {
	env := meEnv{
		ComputerSettingsEnabled:  lookupIs(lookup, "COMPUTER_SETTINGS_ENABLED", "true"),
		DesktopHostChoiceEnabled: strings.TrimSpace(lookupValue(lookup, "RAKAZO_DESKTOP_STACK_TOKEN")) != "",
		SandboxProvider:          resolveSandboxProvider(lookup),
		McpStdioEnabled:          lookupIs(lookup, "MCP_STDIO_ENABLED", "true"),
		McpStdioAllowedCommands:  splitCommaList(lookupValue(lookup, "MCP_STDIO_ALLOWED_COMMANDS")),
		AdminEmails:              lowerAll(splitEnvList(lookupValue(lookup, "RAKAZO_ADMIN_EMAILS"))),
		BillingConfigured:        billingConfigured(lookup),
		PaymentWalletProvider:    resolvePaymentWalletProvider(lookupValue(lookup, "PAYMENT_WALLET_PROVIDER")),
		NavLinks:                 []NavLink{},
	}
	if value, present := lookup("AGENT_RUNTIME"); present {
		env.AgentRuntime = value
	} else {
		env.AgentRuntime = "pi"
	}
	env.NavLinks, env.NavLinksUnknown = parseNavLinks(lookupValue(lookup, "RAKAZO_NAV_LINKS"))
	env.DriveURL = driveURL(lookupValue(lookup, "DRIVE_URL"))
	env.MaxAttachmentsPerMessage, env.AttachmentsUnknown = attachmentCount(lookupValue(lookup, "MAX_ATTACHMENTS_PER_MESSAGE"))
	return env
}

func lookupValue(lookup func(string) (string, bool), name string) string {
	value, _ := lookup(name)
	return value
}

func lookupIs(lookup func(string) (string, bool), name, want string) bool {
	return lookupValue(lookup, name) == want
}

func splitEnvList(value string) []string {
	return strings.FieldsFunc(value, func(r rune) bool {
		return r == ',' || r == ' ' || r == '\t' || r == '\n' || r == '\r' || r == '\v' || r == '\f'
	})
}

func splitCommaList(value string) []string {
	parts := strings.Split(value, ",")
	kept := []string{}
	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			kept = append(kept, trimmed)
		}
	}
	return kept
}

func lowerAll(values []string) []string {
	lowered := make([]string, len(values))
	for index, value := range values {
		lowered[index] = strings.ToLower(value)
	}
	return lowered
}

// attachmentCount is attachmentCountFromEnv: a whole number 1..100, else the default 4.
// An invalid value is reported so `me` can decline; the TypeScript server refuses to start.
func attachmentCount(value string) (int, bool) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return 4, false
	}
	if !digitsOnly(trimmed) {
		return 4, true
	}
	count, err := strconv.Atoi(trimmed)
	if err != nil || count < 1 || count > 100 {
		return 4, true
	}
	return count, false
}

func digitsOnly(value string) bool {
	if value == "" {
		return false
	}
	for _, r := range value {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// billingConfigured is stripeBillingConfigFromEnv's "any value set" plus the local
// emulator: what makes Boolean(deps.billing) true.
func billingConfigured(lookup func(string) (string, bool)) bool {
	for _, name := range []string{"STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_ID"} {
		if strings.TrimSpace(lookupValue(lookup, name)) != "" {
			return true
		}
	}
	return lookupIs(lookup, "BILLING_EMULATOR", "true") && lookupValue(lookup, "NODE_ENV") != "production"
}

// resolvePaymentWalletProvider is resolvePaymentWalletProvider (packages/adapters/src/
// payments/payment-wallet-factory.ts:7).
func resolvePaymentWalletProvider(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "link":
		return "link"
	case "emulator":
		return "emulator"
	}
	return "none"
}

// sandboxRequiredEnv is the required env binding of each computer provider with any
// (packages/adapters/src/providers/computer/*/*-computer.ts). Providers without an entry
// require nothing; "desktop" and "fake" bind nothing either.
var sandboxRequiredEnv = map[string][]string{
	"boat":       {"BOAT_API_KEY"},
	"boxd":       {"BOXD_API_KEY"},
	"createos":   {"CREATEOS_SANDBOX_API_KEY"},
	"daytona":    {"DAYTONA_API_KEY"},
	"e2b":        {"E2B_API_KEY"},
	"incus":      {"INCUS_SANDBOX_URL", "INCUS_SANDBOX_CLIENT_CERT", "INCUS_SANDBOX_CLIENT_KEY"},
	"instabox":   {"INSTABOX_API_KEY"},
	"novita":     {"NOVITA_API_KEY"},
	"railway":    {"RAILWAY_API_TOKEN", "RAILWAY_ENVIRONMENT_ID"},
	"wuying":     {"WUYING_ACCESS_KEY_ID", "WUYING_ACCESS_KEY_SECRET", "WUYING_DESKTOP_ID", "WUYING_END_USER_ID", "WUYING_MCP_URL", "WUYING_MCP_TOKEN"},
	"kubernetes": {},
	"local-vm":   {},
	"none":       {},
	"docker":     {},
	"desktop":    {},
	"fake":       {},
}

// resolveSandboxProvider is resolveSandboxProvider: a blank SANDBOX_PROVIDER means none,
// a known provider missing a required variable means none, and Docker in production
// without a supervisor token means none. An unknown kind is answered as given.
func resolveSandboxProvider(lookup func(string) (string, bool)) string {
	configured, present := lookup("SANDBOX_PROVIDER")
	if present && strings.TrimSpace(configured) == "" {
		return "none"
	}
	requested := strings.TrimSpace(configured)
	if requested == "" {
		requested = "docker"
	}
	required, known := sandboxRequiredEnv[requested]
	if !known {
		return requested
	}
	for _, name := range required {
		if strings.TrimSpace(lookupValue(lookup, name)) == "" {
			return "none"
		}
	}
	if requested == "docker" && lookupValue(lookup, "NODE_ENV") == "production" &&
		strings.TrimSpace(lookupValue(lookup, "SANDBOX_SUPERVISOR_TOKEN")) == "" {
		return "none"
	}
	return requested
}

var navLinkID = regexp.MustCompile(`^[a-z0-9-]{1,32}$`)
var reservedNavPrefixes = []string{"/app", "/api", "/rpc", "/novnc", "/health"}
var navPathWhitespace = regexp.MustCompile(`[\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}\\]`)

// parseNavLinks is parseNavLinks (packages/contracts/src/clients/nav-links.ts:34):
// a JSON array of at most 10 strict links with distinct ids. The second result is true
// when the value is not something this port can confirm the TypeScript parses the same
// way, so `me` declines rather than guess.
func parseNavLinks(value string) ([]NavLink, bool) {
	if strings.TrimSpace(value) == "" {
		return []NavLink{}, false
	}
	var raw any
	decoder := json.NewDecoder(strings.NewReader(value))
	decoder.UseNumber()
	if err := decoder.Decode(&raw); err != nil {
		return []NavLink{}, true
	}
	items, ok := raw.([]any)
	if !ok || len(items) > 10 {
		return []NavLink{}, true
	}
	links := make([]NavLink, 0, len(items))
	seen := map[string]bool{}
	for _, item := range items {
		object, ok := item.(map[string]any)
		if !ok {
			return []NavLink{}, true
		}
		for key := range object {
			if key != "id" && key != "label" && key != "path" && key != "trusted" {
				return []NavLink{}, true
			}
		}
		id, _ := object["id"].(string)
		label, _ := object["label"].(string)
		path, _ := object["path"].(string)
		trusted := false
		if rawTrusted, present := object["trusted"]; present {
			flag, ok := rawTrusted.(bool)
			if !ok {
				return []NavLink{}, true
			}
			trusted = flag
		}
		if !navLinkID.MatchString(id) || seen[id] {
			return []NavLink{}, true
		}
		seen[id] = true
		trimmedLabel := strings.TrimSpace(label)
		labelLength := len([]rune(trimmedLabel))
		if labelLength < 1 || labelLength > 40 {
			return []NavLink{}, true
		}
		if !simpleNavPath(path) {
			return []NavLink{}, true
		}
		links = append(links, NavLink{ID: id, Label: trimmedLabel, Path: path, Trusted: trusted})
	}
	return links, false
}

// simpleNavPath checks the paths this port can confirm isSameOriginPath accepts and keeps
// byte for byte: a plain absolute path with no query, fragment, dot segment, percent
// escape or backslash/whitespace. Anything else is left to TypeScript.
func simpleNavPath(path string) bool {
	if !strings.HasPrefix(path, "/") || strings.HasPrefix(path, "//") || len(path) > 400 {
		return false
	}
	if navPathWhitespace.MatchString(path) {
		return false
	}
	if strings.ContainsAny(path, "?#%\\") {
		return false
	}
	for _, segment := range strings.Split(path, "/") {
		if segment == "." || segment == ".." {
			return false
		}
	}
	parsed, err := url.Parse(path)
	if err != nil || parsed.Host != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return false
	}
	name := parsed.Path
	for _, prefix := range reservedNavPrefixes {
		if name == prefix || strings.HasPrefix(name, prefix+"/") {
			return false
		}
	}
	return true
}

// errMeEnv is unused by Load; kept here so a caller that wants to refuse startup can
// tell an unknown menu-link configuration apart.
var errMeEnv = errors.New("unsupported navigation link configuration")

// driveURL is parseExtraAuthOrigins' acceptance for DRIVE_URL: a bare https origin, or http on a
// private or loopback host. Anything else is ignored, as the TypeScript side does.
func driveURL(value string) string {
	parsed, err := url.Parse(strings.TrimSpace(value))
	if err != nil || parsed.Host == "" || (parsed.Path != "" && parsed.Path != "/") ||
		parsed.RawQuery != "" || parsed.Fragment != "" || parsed.User != nil {
		return ""
	}
	switch parsed.Scheme {
	case "https":
	case "http":
		host := parsed.Hostname()
		addr, addrErr := netip.ParseAddr(host)
		if host != "localhost" && (addrErr != nil || !(addr.IsPrivate() || addr.IsLoopback())) {
			return ""
		}
	default:
		return ""
	}
	return parsed.Scheme + "://" + parsed.Host
}
