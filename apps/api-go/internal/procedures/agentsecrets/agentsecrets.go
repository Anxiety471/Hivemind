// Package agentsecrets ports agentSecrets.list: the Space owner's command variables, read from
// the vault's metadata (apps/api/src/bots/agent-secrets.ts:34-44).
//
// The list never opens a saved value: it reads each row's name, auth kind and timestamps and
// keeps the command variables whose name exports as an environment variable. No secret write or
// read happens, so the Prisma secret-persistence hook has nothing to reproduce.
package agentsecrets

import (
	"context"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"golang.org/x/text/cases"
	"golang.org/x/text/language"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
)

// namePattern is AGENT_SECRET_NAME_PATTERN (packages/contracts/src/bots/agent-secret-name.ts:3).
var namePattern = regexp.MustCompile(`^[A-Z_][A-Z0-9_]{0,63}$`)

// upper is JavaScript's String#toUpperCase: the Unicode default uppercase mapping, including the
// full mappings strings.ToUpper's simple mapping would miss (ß → SS).
var upper = cases.Upper(language.Und)

// reservedNames is RESERVED_COMMAND_VARIABLE_NAMES (packages/contracts/src/bots/bot-secrets.ts:60-124).
var reservedNames = map[string]bool{
	"PATH": true, "HOME": true, "USER": true, "LOGNAME": true, "SHELL": true, "PWD": true,
	"OLDPWD": true, "TERM": true, "IFS": true, "ENV": true, "BASH_ENV": true, "BASHOPTS": true,
	"SHELLOPTS": true, "CDPATH": true, "GLOBIGNORE": true, "PROMPT_COMMAND": true, "PS4": true,
	"TMPDIR": true, "DISPLAY": true, "XAUTHORITY": true, "SSH_AUTH_SOCK": true,
	"NODE_OPTIONS": true, "NODE_PATH": true, "PYTHONPATH": true, "PYTHONHOME": true,
	"PYTHONSTARTUP": true, "PERL5LIB": true, "PERL5OPT": true, "RUBYOPT": true,
	"JAVA_TOOL_OPTIONS": true, "JDK_JAVA_OPTIONS": true, "HTTP_PROXY": true, "HTTPS_PROXY": true,
	"ALL_PROXY": true, "NO_PROXY": true, "SSL_CERT_FILE": true, "SSL_CERT_DIR": true,
	"SSLKEYLOGFILE": true, "REQUESTS_CA_BUNDLE": true, "CURL_CA_BUNDLE": true,
	"NODE_EXTRA_CA_CERTS": true, "NODE_TLS_REJECT_UNAUTHORIZED": true, "GIT_SSL_CAINFO": true,
	"GIT_SSL_NO_VERIFY": true, "OPENSSL_CONF": true, "OPENSSL_ENGINES": true,
	"OPENSSL_MODULES": true, "GIT_SSH": true, "GIT_SSH_COMMAND": true, "GIT_ASKPASS": true,
	"GIT_PROXY_COMMAND": true, "GIT_EXTERNAL_DIFF": true, "GIT_PAGER": true, "GIT_EDITOR": true,
	"GIT_EXEC_PATH": true, "GIT_TEMPLATE_DIR": true, "GCONV_PATH": true, "SSH_ASKPASS": true,
	"SSH_ASKPASS_REQUIRE": true,
}

// reservedPrefixes is RESERVED_COMMAND_VARIABLE_PREFIXES.
var reservedPrefixes = []string{"LD_", "DYLD_", "RAKAZO_", "GIT_CONFIG_", "NPM_CONFIG_"}

// commandVariableName is commandVariableName: `netbird-setup-key` → `NETBIRD_SETUP_KEY`.
func commandVariableName(credentialName string) string {
	return strings.ReplaceAll(upper.String(credentialName), "-", "_")
}

// commandVariableProblem is commandVariableProblem: why a variable cannot be exported.
func commandVariableProblem(variable string) string {
	if !namePattern.MatchString(variable) {
		return "invalid"
	}
	if reservedNames[variable] {
		return "reserved"
	}
	for _, prefix := range reservedPrefixes {
		if strings.HasPrefix(variable, prefix) {
			return "reserved"
		}
	}
	return ""
}

// Secret is AgentSecretSchema (packages/contracts/src/bots/bot.ts:11-17).
type Secret struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
}

var errOwner = orpc.Forbidden("Only the space owner can do that")

// List implements agentSecrets.list: owner only, the command variables of the vault this Space
// uses (the account's by default, its own under the credentials override). A row whose auth does
// not parse or is not a command variable is skipped; a name that does not export as one is too.
func List(ctx context.Context, database *db.DB, actor db.Actor) (any, *orpc.Error) {
	secrets := []Secret{}
	err := database.Tenant(ctx, actor, func(tx pgx.Tx) error {
		var role string
		err := tx.QueryRow(ctx, `SELECT role FROM space_members WHERE "spaceId" = $1 AND "userId" = $2`,
			actor.SpaceID, actor.UserID).Scan(&role)
		if err == pgx.ErrNoRows || (err == nil && !shared.IsOwnerRole(role)) {
			return errOwner
		}
		if err != nil {
			return err
		}
		var overridden bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM space_setting_overrides
			WHERE "spaceId" = $1 AND "userId" = $2 AND setting = 'credentials')`,
			actor.SpaceID, actor.UserID).Scan(&overridden); err != nil {
			return err
		}
		query := `SELECT name, auth, "createdAt", "updatedAt" FROM vault_credentials
			WHERE "userId" = $1 AND "spaceId" IS NULL ORDER BY name ASC`
		args := []any{actor.UserID}
		if overridden {
			query = `SELECT name, auth, "createdAt", "updatedAt" FROM vault_credentials
				WHERE "userId" = $1 AND "spaceId" = $2 ORDER BY name ASC`
			args = append(args, actor.SpaceID)
		}
		rows, err := tx.Query(ctx, query, args...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var name string
			var auth any
			var created, updated time.Time
			if err := rows.Scan(&name, &auth, &created, &updated); err != nil {
				return err
			}
			if authType(auth) != "command" {
				continue
			}
			variable := commandVariableName(name)
			if commandVariableProblem(variable) != "" {
				continue
			}
			secrets = append(secrets, Secret{
				ID: name, Name: variable,
				CreatedAt: shared.ISO(created), UpdatedAt: shared.ISO(updated),
			})
		}
		return rows.Err()
	})
	if err != nil {
		return nil, shared.Failure(err)
	}
	return secrets, nil
}

// authType is BotSecretAuth.safeParse(auth).data?.type: only a JSON object with a string `type`
// parses as one of its members.
func authType(auth any) string {
	object, ok := auth.(map[string]any)
	if !ok {
		return ""
	}
	kind, _ := object["type"].(string)
	return kind
}
