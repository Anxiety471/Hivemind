package shared

import (
	"strings"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

// GuestRole is the organization role of someone who belongs only through Spaces they were
// invited to (GUEST_ROLE, packages/db/src/billing.ts).
const GuestRole = "guest"

// IsOwnerRole is isOwnerRole: better-auth stores roles as a comma-separated list.
func IsOwnerRole(role string) bool {
	for _, value := range strings.Split(role, ",") {
		if validate.JSTrim(value) == "owner" {
			return true
		}
	}
	return false
}

// OrganizationRole is organizationRole: the role shown and checked for a stored role.
func OrganizationRole(role string) string {
	if IsOwnerRole(role) {
		return "owner"
	}
	for _, value := range strings.Split(role, ",") {
		if validate.JSTrim(value) == "admin" {
			return "admin"
		}
	}
	return "member"
}
