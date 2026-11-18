package procedures

import "testing"

// The registry is the list of procedures the gateway can serve locally; a
// dropped entry would silently fall back to "not implemented" once routed.
func TestRegistryHasTheServedProceduresAndNotTrust(t *testing.T) {
	seen := map[string]bool{}
	for _, procedure := range All(nil) {
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
	// The other pages procedures read share secrets and versions; they stay on TypeScript.
	for _, name := range []string{"pages.get", "pages.rename", "pages.setVisibility", "pages.pin", "pages.remove"} {
		if seen[name] {
			t.Errorf("%s must not be served locally", name)
		}
	}
}
