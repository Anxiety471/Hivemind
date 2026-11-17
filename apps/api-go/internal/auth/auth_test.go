package auth

import (
	"net/http/httptest"
	"net/url"
	"testing"
)

func testService() *Service {
	return New(nil, Config{Secret: []byte("unit-test-secret"), AuthURL: "https://app.example.test"})
}

func TestVerifyAcceptsOnlyTheSignedForm(t *testing.T) {
	service := testService()
	raw := "session-token-0123456789abcdef"
	signature := service.signature(raw)
	if got, ok := service.verify(raw + "." + signature); !ok || got != raw {
		t.Fatalf("valid signature rejected: %q %t", got, ok)
	}
	for _, candidate := range []string{
		raw,
		raw + ".",
		raw + ".short=",
		raw + "." + signature[:len(signature)-1] + "x",
		"x" + raw + "." + signature,
	} {
		if _, ok := service.verify(candidate); ok {
			t.Errorf("accepted %q", candidate)
		}
	}
}

func TestCredentialsReadsCookieAndBearer(t *testing.T) {
	service := testService()
	cookieValue := url.QueryEscape("cookie-token." + service.signature("cookie-token"))
	request := httptest.NewRequest("POST", "/rpc/me", nil)
	request.Header.Set("Cookie", "__Secure-better-auth.session_token="+cookieValue)
	token, name, viaCookie, signed := credentials(request, service.names)
	signedCookieValue := "cookie-token." + service.signature("cookie-token")
	if !signed || !viaCookie || token != signedCookieValue || name != "__Secure-better-auth.session_token" {
		t.Fatalf("cookie = %q %q %t %t", token, name, viaCookie, signed)
	}

	bearer := httptest.NewRequest("POST", "/rpc/me", nil)
	bearer.Header.Set("Authorization", "Bearer bearer-token."+service.signature("bearer-token"))
	token, _, viaCookie, signed = credentials(bearer, service.names)
	if !signed || viaCookie || token != "bearer-token."+service.signature("bearer-token") {
		t.Fatalf("bearer = %q %t %t", token, viaCookie, signed)
	}

	unsigned := httptest.NewRequest("POST", "/rpc/me", nil)
	unsigned.Header.Set("Authorization", "Bearer unsigned-token")
	if _, _, _, signed := credentials(unsigned, service.names); signed {
		t.Error("unsigned bearer was accepted")
	}
}
