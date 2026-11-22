// Package shared holds what the ported procedures have in common.
package shared

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/contentcrypto"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/effects"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/events"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
)

// ISOMillis is Date.prototype.toISOString for a UTC instant.
const ISOMillis = "2006-01-02T15:04:05.000Z"

// ISO formats a database timestamp as toISOString does.
func ISO(at time.Time) string { return at.UTC().Format(ISOMillis) }

// NotFound is the IsolationError the API answers for a row outside the caller's Space.
var NotFound = orpc.NotFound("Resource not found")

// Failure turns an error out of a database call into the response the API gives:
// a failure raised on purpose as is, an unreachable database as 503, anything else 500.
func Failure(err error) *orpc.Error {
	var failure *orpc.Error
	if errors.As(err, &failure) {
		return failure
	}
	if db.IsUnavailable(err) {
		return orpc.Unavailable()
	}
	return orpc.Internal()
}

// OutputInvalid is the failure the router answers when a procedure's result breaks its
// contract schema (a stored value outside an enum, say): a 500 with its own message.
func OutputInvalid() *orpc.Error {
	return orpc.New("INTERNAL_SERVER_ERROR", 500, "Output validation failed")
}

// ModelSelection is one provider/model pair the deployment itself can run.
type ModelSelection struct {
	Provider string
	ModelID  string
}

// Deployment is the process configuration some procedures read: where links to the web
// app point, whether the server sends email (which decides whether an invitee must have
// verified theirs before accepting), and the content key ring the encrypted procedures use.
type Deployment struct {
	WebOrigin     string
	EmailDelivery bool
	// InboundEmailDomain is env.inboundEmail?.domain (apps/api/src/env.ts:416): the lowercased
	// INBOUND_EMAIL_DOMAIN, absent when the server receives no email.
	InboundEmailDomain string
	// MaxComputersPerUser is the raw SANDBOX_MAX_COMPUTERS_PER_USER; procedures resolve it
	// per call as resolveMaxComputersPerUser does, because a bad value fails the call, not
	// the process.
	MaxComputersPerUser string
	// Content is the Space key ring (contentcrypto) that seals and opens rkz1 content. It is
	// nil only in tests that never touch an encrypted model.
	Content *contentcrypto.KeyRing
	// Events publishes a committed thread cursor (events.NotifyCommitted). nil in tests that
	// never append a product event.
	Events events.Publisher
	// Signals is the realtime notifier procedures publish organization and board changes
	// through. nil in tests that never publish one.
	Signals *effects.Notifier
	// Realtime delivers the signals other processes publish (board changes, for the board
	// stream). nil when no listener is wired: a stream then stays open and quiet.
	Realtime *events.Fanout
	// BoardLab is TICKET_BOARD_ENABLED: the board feature this deployment turns on for every
	// account (packages/adapters/src/labs-env.ts:4-11).
	BoardLab bool
	// PhoneCallsEnabled is PHONE_CALLS_ENABLED (phoneCallSettings, call-request.ts:5): the
	// roster shows a bot's incoming call only when calls are opted in.
	PhoneCallsEnabled bool
	// PhoneCallRingSeconds is PHONE_CALL_RING_SECONDS, the positive number or 45.
	PhoneCallRingSeconds float64
	// Audit records the audit events a procedure raises itself (recordAuditEvent). nil in tests
	// that never record one.
	Audit *effects.Recorder
	// Vault is the credential store the VAULT procedures read and write. nil when the process
	// was started without a vault route or without ENCRYPTION_KEY; a procedure that needs it
	// then fails rather than writing a value the TypeScript API could not read.
	Vault *SecretVault
	// DefaultModel is the deployment's main model when a member chose none, nil when the
	// deployment has no usable key or host credentials (PI_DEFAULT_*).
	DefaultModel *ModelSelection
	// ApprovalModel is the environment's Auto Review checker (resolveAutoReviewChecker), and
	// ApprovalModelConfigured is isAutoReviewCheckerConfigured({}).
	ApprovalModel           *ModelSelection
	ApprovalModelConfigured bool
	// Me is the deployment configuration `me` (account.Me) answers from: the same env.ts
	// values the TypeScript API reads. config.MeEnv fills it at startup.
	Me MeConfig
	// Waker wakes a ticket's worker bots through the task queue (retries, backoff, coalescing).
	// nil in tests that never wake one.
	Waker TicketWaker
}

// MeConfig is apps/api/src/env.ts as `me` reads it (meDto, routes/shared.ts:34): the
// fields that come from the environment rather than a row.
type MeConfig struct {
	// DeploymentProvider and DeploymentModel are env.defaultProvider/env.defaultModel:
	// resolveDeploymentModel's provider and model, before a member or deployment choice.
	DeploymentProvider string
	DeploymentModel    string
	// DeploymentModelConfigured and DeploymentModelHostCredentials are
	// env.deploymentModelConfigured/env.deploymentModelHostCredentials.
	DeploymentModelConfigured      bool
	DeploymentModelHostCredentials bool
	// DeploymentModelHostCredentialsUnknown marks the pi-ai environment lookup this port
	// does not carry; `me` declines while it is set.
	DeploymentModelHostCredentialsUnknown bool
	// DeploymentLabs is env.deploymentLabs (deploymentLabsFromEnv): Labs features this
	// deployment turns on for everyone. Only "board" exists today.
	DeploymentLabs []string
	// NavLinks is env.navLinks (parseNavLinks); NavLinksUnknown marks a value this port
	// cannot confirm, so `me` declines.
	NavLinks        []NavLink
	NavLinksUnknown bool
	// ComputerSettingsEnabled is COMPUTER_SETTINGS_ENABLED === "true".
	ComputerSettingsEnabled bool
	// DesktopHostChoiceEnabled is Boolean(env.desktopStackToken).
	DesktopHostChoiceEnabled bool
	// SandboxProvider is env.sandboxProvider (resolveSandboxProvider).
	SandboxProvider string
	// AgentRuntime is env.agentRuntime.
	AgentRuntime string
	// McpStdioEnabled is mcpStdioAvailable({stdioEnabled, allowedCommands}).
	McpStdioEnabled bool
	// AdminEmails is env.adminEmails (RAKAZO_ADMIN_EMAILS, lowercased).
	AdminEmails []string
	// MaxUploadBytes and MaxAttachmentsPerMessage are env.maxUploadSizeBytes and
	// env.maxAttachmentsPerMessage; AttachmentsUnknown marks an invalid
	// MAX_ATTACHMENTS_PER_MESSAGE, which stops the TypeScript server.
	MaxUploadBytes           int64
	MaxAttachmentsPerMessage int
	AttachmentsUnknown       bool
	// BillingConfigured is Boolean(deps.billing): Stripe's secrets or the emulator.
	BillingConfigured bool
	// PaymentWalletProvider is resolvePaymentWalletProvider: "link", "emulator" or "none".
	PaymentWalletProvider string
}

// NavLink is NavLinkSchema, as `me` returns env.navLinks.
type NavLink struct {
	ID      string `json:"id"`
	Label   string `json:"label"`
	Path    string `json:"path"`
	Trusted bool   `json:"trusted"`
}

// TicketWaker queues a wake for each bot, with a short note saying what changed on the ticket.
// It never fails the write that triggered it: a lost wake is recovered by the queue's retries
// and the idle-bot bump.
type TicketWaker interface {
	WakeWorkers(ctx context.Context, spaceID, ticketID string, botIDs []string, note string)
}

// RequireBot is repos.getBot (packages/db/src/repos.ts:415): a bot of the actor's Space that
// is not archived, or the isolation error. TypeScript reads the whole bot, thread and computer
// rows to answer; the thread's encrypted compaction summary is decrypted on the way and the
// value discarded, so the only observable difference is when that ciphertext is unreadable
// (hook-audit.md R1).
func RequireBot(ctx context.Context, tx pgx.Tx, actor db.Actor, botID string) error {
	var found string
	err := tx.QueryRow(ctx, `SELECT id FROM bots WHERE id = $1 AND "spaceId" = $2 AND "archivedAt" IS NULL`, botID, actor.SpaceID).Scan(&found)
	if errors.Is(err, pgx.ErrNoRows) {
		return NotFound
	}
	return err
}

// ISOOrNil is a nullable timestamp's toISOString, or null.
func ISOOrNil(at *time.Time) *string {
	if at == nil {
		return nil
	}
	value := ISO(*at)
	return &value
}
