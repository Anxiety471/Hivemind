package procedures

import (
	"testing"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
)

// The registry is the list of procedures the gateway can serve locally; a
// dropped entry would silently fall back to "not implemented" once routed.
func TestRegistryHasTheServedProceduresAndNotTrust(t *testing.T) {
	seen := map[string]bool{}
	for _, procedure := range All(nil, shared.Deployment{WebOrigin: "https://app.example.test"}) {
		if seen[procedure.Name] {
			t.Errorf("duplicate procedure %s", procedure.Name)
		}
		seen[procedure.Name] = true
		if procedure.Serve == nil {
			t.Errorf("%s has no handler", procedure.Name)
		}
	}
	for _, name := range []string{
		"availability.items", "availability.set", "availability.chooseForSpace",
		"trustedLinkSites.list", "trustedLinkSites.remove",
		"spendingLimit.payments", "spendingLimit.get", "botSections.list", "pages.list",
		"spendingLimit.set",
		"threads.head", "threads.markRead", "threads.markUnread", "threads.snooze", "externalConversations.updatePolicy",
		"scratchpad.list", "scratchpad.create", "scratchpad.update", "scratchpad.remove",
		"approvalRules.list", "approvalRules.set", "spaceSettings.overrides",
		"messaging.link.start", "messaging.identities.setBot", "messaging.identities.unlink", "messaging.channels.list",
		"messaging.channels.respond", "messaging.channels.leave", "messaging.connections.list", "messaging.connections.revoke", "botSections.create", "botSections.update", "botSections.remove",
		"connections.list", "connections.rename", "capabilities.list",
		"usage.list", "usage.summary", "computer.updates",
		"mcp.assignments.all", "mcp.assignments.list", "models.backups",
		"spaces.rename", "spaces.members.list", "spaces.members.add",
		"spaces.invites.preview", "spaces.invites.accept", "spaces.invites.cancel",
		"organizations.list", "organizations.rename", "organizations.members.list",
		"organizations.invitations.preview",
		"models.rename", "pages.rename", "pages.pin", "artifacts.list", "artifacts.listSpace", "artifacts.listVersions",
		"memory.list", "memory.budget", "memory.update", "memory.remove", "memory.exportMarkdown",
		"onboarding.promptFocus", "onboarding.dismissFocus", "onboarding.start", "computer.commands",
		"tickets.list", "tickets.create", "tickets.update", "tickets.move", "tickets.comment",
		"bots.templates", "skills.list", "agentSecrets.list", "audit.events", "vault.activity",
		"computer.dismissUpdate", "computer.dismissDiskWarning",
		"boards.list", "boards.get", "boards.rename",
	} {
		if !seen[name] {
			t.Errorf("missing %s", name)
		}
	}
	// trust needs WHATWG URL parsing and the tldts suffix list; it stays on TypeScript.
	if seen["trustedLinkSites.trust"] {
		t.Error("trustedLinkSites.trust must not be served locally")
	}
	// approvalRules.remove is audited with a caller-chosen id the redaction gate cannot prove safe.
	// spaceSettings.setOverride deletes vault credentials, and the API's Prisma client runs secret
	// persistence on that (write-ahead cleanup jobs, remote SecretStore deletes) that a plain DELETE skips.
	for _, name := range []string{"approvalRules.remove", "autoReview.get", "autoReview.set", "spaceSettings.setOverride"} {
		if seen[name] {
			t.Errorf("%s must not be served locally", name)
		}
	}
	// The rest of threads reads or writes encrypted messages and events, or starts runs.
	for _, name := range []string{"threads.get", "threads.messages", "threads.send", "threads.followUp", "threads.stop", "threads.clear", "threads.subscribe"} {
		if seen[name] {
			t.Errorf("%s must not be served locally", name)
		}
	}
	// installations.* need Slack and the delivery outbox; status and installations.list read
	// deployment configuration; connections.respond writes the outbox.
	for _, name := range []string{"messaging.status", "messaging.installations.list", "messaging.installations.start",
		"messaging.installations.complete", "messaging.installations.remove", "messaging.connections.respond"} {
		if seen[name] {
			t.Errorf("%s must not be served locally", name)
		}
	}
	// pages.get with link:true reads the page's sealed share token from the secret store
	// (apps/api/src/pages.ts:141-153, secrets.load at :151, called from getPage at :180); setVisibility
	// and remove write it. They stay on TypeScript.
	for _, name := range []string{"pages.get", "pages.setVisibility", "pages.remove"} {
		if seen[name] {
			t.Errorf("%s must not be served locally", name)
		}
	}
	// create seeds an encrypted memory document; remove, the departures and account deletion
	// run teardown; invites.create and organizations.invitations.create send email;
	// members.remove and invitations.accept hand Spaces over or sync billing seats. setRole and
	// invitations.cancel are served: their organization signal is internal/effects.
	for _, name := range []string{"spaces.create", "spaces.remove", "spaces.members.remove", "spaces.members.leave",
		"spaces.invites.create", "organizations.create", "organizations.remove",
		"organizations.members.remove", "organizations.invitations.create",
		"organizations.invitations.accept"} {
		if seen[name] {
			t.Errorf("%s must not be served locally", name)
		}
	}
}

// organizations.members.list builds invitation links from WEB_ORIGIN. For an origin the URL joiner does
// not normalise the way WHATWG does, it is left to TypeScript instead of answering a different link.
func TestMembersListIsServedOnlyForAnOriginItCanJoin(t *testing.T) {
	names := func(deployment shared.Deployment) map[string]bool {
		served := map[string]bool{}
		for _, procedure := range All(nil, deployment) {
			served[procedure.Name] = true
		}
		return served
	}
	for _, origin := range []string{"https://app.example.test", "http://127.0.0.1:5173", "https://Example.COM:443"} {
		if !names(shared.Deployment{WebOrigin: origin})["organizations.members.list"] {
			t.Errorf("not served for %q", origin)
		}
	}
	for _, origin := range []string{"", "https://bücher.example", "https://user:pw@example.com", "ftp://example.com", "not a url"} {
		served := names(shared.Deployment{WebOrigin: origin})
		if served["organizations.members.list"] {
			t.Errorf("served for %q", origin)
		}
		if !served["organizations.list"] || !served["spaces.rename"] {
			t.Errorf("the other membership procedures vanished for %q", origin)
		}
	}
}
