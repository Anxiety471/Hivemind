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
		"spendingLimit.payments", "spendingLimit.get",
	} {
		if !seen[name] {
			t.Errorf("missing %s", name)
		}
	}
	// trust needs WHATWG URL parsing and the tldts suffix list; it stays on TypeScript.
	if seen["trustedLinkSites.trust"] {
		t.Error("trustedLinkSites.trust must not be served locally")
	}
	// set is audited as a security event and takes the spending advisory lock; it stays on TypeScript.
	if seen["spendingLimit.set"] {
		t.Error("spendingLimit.set must not be served locally")
	}
}
