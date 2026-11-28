package shared

import "strings"

// IsAdmin is isAdmin (apps/api/src/auth/admins.ts:7): listed in RAKAZO_ADMIN_EMAILS with a
// verified address.
func IsAdmin(admins []string, email string, verified bool) bool {
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
