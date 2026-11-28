package auth

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestDriveOpenRedirectsVisitorsWithoutASession(t *testing.T) {
	handler := New(nil, Config{Secret: []byte("secret"), CookieDomain: "example.com"}).DriveOpen("https://drive.example.com")

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, DriveOpenPath+"?space=a%20b", nil))

	if recorder.Code != http.StatusFound {
		t.Fatalf("status = %d, want 302", recorder.Code)
	}
	if got, want := recorder.Header().Get("Location"), "https://drive.example.com/app/files?space=a+b"; got != want {
		t.Fatalf("Location = %q, want %q", got, want)
	}
	if cookies := recorder.Header().Values("Set-Cookie"); len(cookies) != 0 {
		t.Fatalf("set cookies without a session: %v", cookies)
	}
}

func TestDriveOpenRefusesOtherMethods(t *testing.T) {
	handler := New(nil, Config{Secret: []byte("secret")}).DriveOpen("https://drive.example.com")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, DriveOpenPath, nil))
	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", recorder.Code)
	}
}
