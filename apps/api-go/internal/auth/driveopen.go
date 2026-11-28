package auth

import (
	"net/http"
	"net/url"
	"strings"
	"time"
)

// DriveOpenPath is where the web app sends the Files menu item (DRIVE_OPEN_PATH in
// packages/contracts/src/account/me.ts).
const DriveOpenPath = "/api/drive/open"

// driveSpaceParam carries the Space the Files item was opened from (DRIVE_SPACE_PARAM).
const driveSpaceParam = "space"

// DriveOpen hands the signed-in browser's session to the Drive app, then redirects to its Files
// page. A browser that signed in before COOKIE_DOMAIN was set holds a host-only session cookie
// the Drive host never receives; it is expired and set again for the cookie domain, so the person
// is not asked to sign in twice. A visitor without a session is redirected the same way and signs
// in on the Drive host.
func (s *Service) DriveOpen(driveURL string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		target, err := url.Parse(driveURL)
		if err != nil || target.Host == "" {
			http.NotFound(w, r)
			return
		}
		target.Path = "/app/files"
		target.RawQuery = ""
		if space := r.URL.Query().Get(driveSpaceParam); space != "" {
			target.RawQuery = url.Values{driveSpaceParam: {space}}.Encode()
		}
		w.Header().Set("Cache-Control", "no-store")
		if s.config.CookieDomain != "" {
			if session, failure := s.session(r.Context(), r); failure == nil && session.ViaCookie {
				s.shareSession(w, session)
			}
		}
		http.Redirect(w, r, target.String(), http.StatusFound)
	})
}

// shareSession expires the host-only copy of the session cookie, then sets it for the domain.
func (s *Service) shareSession(w http.ResponseWriter, session *Session) {
	remaining := time.Until(session.ExpiresAt)
	if remaining <= 0 {
		return
	}
	secure := strings.HasPrefix(session.CookieName, "__Secure-")
	http.SetCookie(w, &http.Cookie{
		Name:     session.CookieName,
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   secure,
	})
	http.SetCookie(w, &http.Cookie{
		Name:     session.CookieName,
		Value:    url.QueryEscape(session.Token + "." + s.signature(session.Token)),
		Path:     "/",
		Domain:   s.config.CookieDomain,
		MaxAge:   int(remaining.Seconds()),
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
	})
}
