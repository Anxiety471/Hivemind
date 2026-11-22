package shared

import (
	"errors"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/secretstore"
)

// SecretVault is the credential store a VAULT procedure works through. It is
// nil in a process started without a vault route, or without ENCRYPTION_KEY:
// such a process serves every other procedure and must keep starting (Lane F's
// proxy-only deployment), so a vault procedure that somehow reaches it answers
// 500 rather than sealing with no key.
type SecretVault struct {
	// Writer is the local SecretStore with its cross-process announcement: every put and
	// delete tells the other API processes the ref changed.
	Writer *secretstore.Writer
	// Persistence is the secret-persistence hook for the SQL writes Go makes: capturing the
	// references a delete drops, and cleaning them after the commit exactly as the Prisma hook
	// does. It owns the same store as Writer.
	Persistence *secretstore.Persistence
}

// VaultDeps is the vault a procedure needs, or the failure it answers when the
// process has none, matching a TypeScript process whose secret store threw.
func VaultDeps(vault *SecretVault) (*SecretVault, error) {
	if vault == nil || vault.Writer == nil || vault.Persistence == nil {
		return nil, errors.New("secretstore: this process has no credential store configured")
	}
	return vault, nil
}
