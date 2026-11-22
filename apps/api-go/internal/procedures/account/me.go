// Package account ports the account-level reads: `me` (meDto, apps/api/src/routes/
// shared.ts). bootstrap reuses Me as well.
//
// me is a deployment-aware read: most of its fields come straight from rows, but the
// model defaults, computer host, Labs, menu links, admin list and billing flags come from
// the process environment. This port answers only what its own configuration can
// reproduce exactly and declines the request when the TypeScript answer depends on
// something it cannot see (pi-ai's host-credential table, the billing adapter's funding
// read, an unverifiable RAKAZO_NAV_LINKS path).
package account

import (
	"context"
	"errors"
	"regexp"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/local"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/modelcredentials"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/models"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
)

// labFeatures is LAB_FEATURES (packages/contracts/src/labs.ts:4).
var labFeatures = []string{"board"}

// MeView is MeSchema (packages/contracts/src/account/me.ts:14) as meDto fills it. Fields the
// schema makes optional are always sent, as meDto sends them.
type MeView struct {
	MaxUploadSizeBytes       int64            `json:"maxUploadSizeBytes"`
	MaxAttachmentsPerMessage int              `json:"maxAttachmentsPerMessage"`
	Labs                     []string         `json:"labs"`
	LabsAvailable            []string         `json:"labsAvailable"`
	TicketBoardEnabled       bool             `json:"ticketBoardEnabled"`
	PhoneCallsEnabled        bool             `json:"phoneCallsEnabled"`
	NavLinks                 []shared.NavLink `json:"navLinks"`
	UserID                   string           `json:"userId"`
	Email                    string           `json:"email"`
	Name                     string           `json:"name"`
	SpaceID                  string           `json:"spaceId"`
	IsDeploymentOwner        bool             `json:"isDeploymentOwner"`
	IsAdmin                  bool             `json:"isAdmin"`
	NeedsModel               bool             `json:"needsModel"`
	DefaultProvider          string           `json:"defaultProvider"`
	DefaultModel             string           `json:"defaultModel"`
	HostCredentialProvider   *string          `json:"hostCredentialProvider"`
	HostCredentialSource     *string          `json:"hostCredentialSource"`
	ComputerHost             *string          `json:"computerHost"`
	CanChooseHostComputer    bool             `json:"canChooseHostComputer"`
	SandboxProvider          string           `json:"sandboxProvider"`
	ComputerSettingsEnabled  bool             `json:"computerSettingsEnabled"`
	McpStdioEnabled          bool             `json:"mcpStdioEnabled"`
	AvatarStyle              string           `json:"avatarStyle"`
	BotAvatarSet             string           `json:"botAvatarSet"`
	Timezone                 *string          `json:"timezone"`
	Locale                   *string          `json:"locale"`
	BillingEnabled           bool             `json:"billingEnabled"`
	NeedsSignupSurvey        bool             `json:"needsSignupSurvey"`
	PaymentWalletProvider    *PaymentWallet   `json:"paymentWalletProvider"`
}

// PaymentWallet is MeSchema's paymentWalletProvider: the deployment's wallet, when it has one.
type PaymentWallet struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type userRow struct {
	email         string
	name          string
	emailVerified bool
	timezone      *string
	locale        *string
	botAvatarSet  string
	labs          []string
	signupSurvey  bool
}

type deploymentRow struct {
	defaultModelProvider   *string
	defaultModelID         *string
	computerHost           *string
	computerProvider       *string
	computerProviderCipher *string
}

// Me implements `me`. It declines (local.ErrDecline) when its configuration cannot
// reproduce the TypeScript answer exactly; see the package comment.
func Me(
	ctx context.Context,
	database *db.DB,
	deployment *shared.Deployment,
	actor db.Actor,
) (any, *orpc.Error) {
	config := &deployment.Me
	if config.DeploymentModelHostCredentialsUnknown || config.NavLinksUnknown || config.AttachmentsUnknown {
		return nil, local.ErrDecline
	}
	var row userRow
	var settings *deploymentRow
	var admin bool
	var main *models.RoleChoice
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx, `SELECT u.email, u.name, u."emailVerified", u.timezone, u.locale,
				u."botAvatarSet", u.labs,
				EXISTS (SELECT 1 FROM signup_surveys s WHERE s."userId" = u.id)
			FROM "user" u WHERE u.id = $1`, actor.UserID).
			Scan(&row.email, &row.name, &row.emailVerified, &row.timezone, &row.locale,
				&row.botAvatarSet, &row.labs, &row.signupSurvey); err != nil {
			return err
		}
		loaded, err := readDeploymentSettings(ctx, tx)
		if err != nil {
			return err
		}
		settings = loaded
		admin = isAdmin(config.AdminEmails, row.email, row.emailVerified)
		primary, err := models.AppliedPrimary(ctx, tx, actor, "main")
		if err != nil {
			return err
		}
		if primary == nil {
			return nil
		}
		if deployment.Vault == nil {
			// The connection's presence can depend on its secret (a compatible server's
			// model list), and the TypeScript side always reads it with one.
			return local.ErrDecline
		}
		vault, err := shared.VaultDeps(deployment.Vault)
		if err != nil {
			return local.ErrDecline
		}
		connected, err := modelcredentials.ConnectedModelCredential(
			ctx, tx, vault, actor, primary.Provider, primary.ModelID, primary.CredentialID,
		)
		if err != nil {
			return err
		}
		if connected {
			main = primary
		}
		return nil
	})
	if err != nil {
		return nil, shared.Failure(err)
	}

	// A billing deployment's answer for a member with no connected main model depends on
	// the billing adapter's funding read (hasHostedModelCredits and status), which this
	// port does not carry.
	if config.BillingConfigured && main == nil {
		return nil, local.ErrDecline
	}

	labs := resolveLabs(row.labs, config.DeploymentLabs)
	sandboxProvider := effectiveSandboxProvider(settings, config.SandboxProvider)

	provider, model := defaultModel(main, settings, config)
	hostProvider, hostSource := hostCredentials(main, settings, config)

	me := MeView{
		MaxUploadSizeBytes:       config.MaxUploadBytes,
		MaxAttachmentsPerMessage: config.MaxAttachmentsPerMessage,
		Labs:                     labs,
		LabsAvailable:            labsAvailable(config.DeploymentLabs),
		TicketBoardEnabled:       contains(labs, "board"),
		PhoneCallsEnabled:        deployment.PhoneCallsEnabled,
		NavLinks:                 config.NavLinks,
		UserID:                   actor.UserID,
		Email:                    row.email,
		Name:                     row.name,
		SpaceID:                  actor.SpaceID,
		IsDeploymentOwner:        false,
		IsAdmin:                  admin,
		NeedsModel:               config.AgentRuntime != "scripted" && main == nil && !hasDeployment(config),
		DefaultProvider:          canonicalProvider(provider),
		DefaultModel:             model,
		HostCredentialProvider:   hostProvider,
		HostCredentialSource:     hostSource,
		ComputerHost:             computerHostFor(settings, sandboxProvider),
		CanChooseHostComputer:    config.DesktopHostChoiceEnabled && sandboxProvider == "docker",
		SandboxProvider:          sandboxProvider,
		ComputerSettingsEnabled:  config.ComputerSettingsEnabled,
		McpStdioEnabled:          admin && config.McpStdioEnabled,
		AvatarStyle:              "organic",
		BotAvatarSet:             resolveAvatarSet(row.botAvatarSet),
		Timezone:                 row.timezone,
		Locale:                   row.locale,
		BillingEnabled:           config.BillingConfigured,
		NeedsSignupSurvey:        config.BillingConfigured && !row.signupSurvey,
		PaymentWalletProvider:    paymentWallet(config.PaymentWalletProvider),
	}
	if me.NavLinks == nil {
		me.NavLinks = []shared.NavLink{}
	}
	if failure := validateMe(me); failure != nil {
		return nil, failure
	}
	return me, nil
}

func readDeploymentSettings(ctx context.Context, tx pgx.Tx) (*deploymentRow, error) {
	var row deploymentRow
	err := tx.QueryRow(ctx, `SELECT "defaultModelProvider", "defaultModelId", "computerHost",
			"computerProvider", "computerProviderCipher"
		FROM deployment_settings WHERE id = 'default'`).
		Scan(&row.defaultModelProvider, &row.defaultModelID, &row.computerHost,
			&row.computerProvider, &row.computerProviderCipher)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// isAdmin is isAdmin (apps/api/src/auth/admins.ts:7): listed in RAKAZO_ADMIN_EMAILS with a
// verified address.
func isAdmin(admins []string, email string, verified bool) bool {
	if len(admins) == 0 || !verified {
		return false
	}
	lowered := strings.ToLower(email)
	for _, admin := range admins {
		if admin == lowered {
			return true
		}
	}
	return false
}

// defaultModel is meDto's defaultProvider/defaultModel: the member's connected main model,
// else the deployment's primary (deployment_settings over PI_DEFAULT_*).
func defaultModel(main *models.RoleChoice, settings *deploymentRow, config *shared.MeConfig) (string, string) {
	if main != nil {
		return main.Provider, main.ModelID
	}
	provider := config.DeploymentProvider
	if settings != nil && settings.defaultModelProvider != nil {
		provider = *settings.defaultModelProvider
	}
	model := ""
	if settings != nil {
		model = usableModelID(settings.defaultModelID)
	}
	if model == "" {
		model = usableModelID(&config.DeploymentModel)
	}
	if provider == "" || model == "" {
		return config.DeploymentProvider, config.DeploymentModel
	}
	return provider, model
}

// hostCredentials is hostCredentials(...) in meDto: the provider and credential kind shown
// only while the active default is the deployment's own, running on host credentials.
func hostCredentials(main *models.RoleChoice, settings *deploymentRow, config *shared.MeConfig) (*string, *string) {
	if main != nil || !config.DeploymentModelHostCredentials {
		return nil, nil
	}
	if settings != nil && settings.defaultModelProvider != nil && *settings.defaultModelProvider != "" {
		return nil, nil
	}
	provider := config.DeploymentProvider
	source := hostCredentialSource(provider)
	return &provider, &source
}

// hostCredentialSource is hostCredentialSource (packages/adapters/src/models/
// deployment-model.ts:16): the provider definition's hostCredentials.source, else "host".
func hostCredentialSource(provider string) string {
	switch provider {
	case "google":
		return "Google Cloud"
	case "amazon-bedrock":
		return "AWS IAM"
	case "claude-code":
		return "CLI"
	}
	return "host"
}

func hasDeployment(config *shared.MeConfig) bool {
	return config.DeploymentModelConfigured
}

// effectiveSandboxProvider is effectiveSandboxProvider (apps/api/src/computers/
// computer-provider-config.ts:384): the deployment's provider, unless Settings chose one.
func effectiveSandboxProvider(settings *deploymentRow, envProvider string) string {
	if envProvider == "desktop" || envProvider == "fake" {
		return envProvider
	}
	if settings != nil && settings.computerProvider != nil && *settings.computerProvider != "" &&
		settings.computerProviderCipher != nil && *settings.computerProviderCipher != "" {
		return *settings.computerProvider
	}
	return envProvider
}

// computerHostFor is computerHostFor: where computers run once Settings' choice applies.
func computerHostFor(settings *deploymentRow, sandboxProvider string) *string {
	if sandboxProvider == "desktop" {
		host := "this-mac"
		return &host
	}
	if sandboxProvider != "docker" || settings == nil || settings.computerHost == nil {
		return nil
	}
	if *settings.computerHost == "this-mac" || *settings.computerHost == "docker" {
		host := *settings.computerHost
		return &host
	}
	return nil
}

// resolveLabs is resolveLabs: known features the account stored, plus the deployment's.
func resolveLabs(stored, deployment []string) []string {
	labs := []string{}
	for _, feature := range labFeatures {
		if contains(deployment, feature) || contains(stored, feature) {
			labs = append(labs, feature)
		}
	}
	return labs
}

// labsAvailable is LAB_FEATURES the deployment does not turn on for everyone.
func labsAvailable(deployment []string) []string {
	available := []string{}
	for _, feature := range labFeatures {
		if !contains(deployment, feature) {
			available = append(available, feature)
		}
	}
	return available
}

func paymentWallet(kind string) *PaymentWallet {
	switch kind {
	case "link":
		return &PaymentWallet{ID: "link", Name: "Link"}
	case "emulator":
		return &PaymentWallet{ID: "emulator", Name: "Emulator Wallet"}
	}
	return nil
}

// usableModelID is usableModelId (packages/contracts/src/models/model-connections.ts:46).
func usableModelID(value *string) string {
	if value == nil {
		return ""
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" || trimmed == "null" || trimmed == "undefined" {
		return ""
	}
	return trimmed
}

// canonicalProvider is canonicalPiProviderId (packages/contracts/src/models/
// model-provider.ts:17).
func canonicalProvider(provider string) string {
	if provider == "azure-openai-responses" {
		return "azure"
	}
	return provider
}

// resolveAvatarSet is resolveBotAvatarSet: the icon set new and unpinned bots wear.
func resolveAvatarSet(value string) string {
	if value == "rakazo" {
		return "rakazo"
	}
	return "organic"
}

func contains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

// emailPattern is MeSchema's z.string().email() for the values a deployment stores: an
// address with a dot in the domain, no whitespace. A stored address outside it makes the
// TypeScript router answer the output failure.
var emailPattern = regexp.MustCompile(`^[^\s@]+@[^\s@]+\.[^\s@]+$`)

// validateMe is the router's parse of MeSchema for the stored values meDto echoes.
func validateMe(me MeView) *orpc.Error {
	if me.UserID == "" || me.SpaceID == "" || !emailPattern.MatchString(me.Email) {
		return shared.OutputInvalid()
	}
	return nil
}
