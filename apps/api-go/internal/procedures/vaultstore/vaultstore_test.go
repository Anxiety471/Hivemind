package vaultstore

import (
	"strings"
	"testing"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/effects"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

// destinationIssues parses one destination and returns its issue messages.
func parseDestinationIssues(t *testing.T, text string, nameOptional bool) (Destination, bool, []string) {
	t.Helper()
	encoded := []byte(text)
	decoded, err := validate.Decode([]byte(`{"destination":`+string(encoded)+`}`), nil)
	if err != nil {
		t.Fatalf("decode %s: %v", text, err)
	}
	destination, hasName, issues := parseDestinationInput(decoded.Field("destination"),
		validate.Path{"destination"}, nameOptional)
	messages := make([]string, 0, len(issues))
	for _, issue := range issues {
		messages = append(messages, issue["message"].(string))
	}
	return destination, hasName, messages
}

func TestDestinationShapeParity(t *testing.T) {
	cases := []struct {
		name     string
		json     string
		messages []string
	}{
		{
			name:     "bearer without origin",
			json:     `{"name":"api","auth":{"type":"bearer"}}`,
			messages: []string{"A site is required"},
		},
		{
			name:     "command siteless",
			json:     `{"name":"api","auth":{"type":"command"}}`,
			messages: nil,
		},
		{
			name:     "name pattern",
			json:     `{"name":"Bad Name","origin":"https://example.test","auth":{"type":"bearer"}}`,
			messages: []string{"Invalid string: must match pattern /^[a-z][a-z0-9_-]{0,63}$/"},
		},
		{
			name:     "discriminator",
			json:     `{"name":"api","origin":"https://example.test","auth":{"type":"bogus"}}`,
			messages: []string{"Invalid discriminator value. Expected 'bearer' | 'header' | 'basic' | 'login' | 'command' | 'card' | 'contact'"},
		},
		{
			name:     "header without name",
			json:     `{"name":"api","origin":"https://example.test","auth":{"type":"header"}}`,
			messages: []string{"Invalid input: expected string, received undefined"},
		},
		{
			name:     "forbidden header",
			json:     `{"name":"api","origin":"https://example.test","auth":{"type":"header","name":"Host"}}`,
			messages: []string{"Unsupported credential header"},
		},
		{
			name:     "basic username colon",
			json:     `{"name":"api","origin":"https://example.test","auth":{"type":"basic","username":"a:b"}}`,
			messages: []string{"Invalid string: must match pattern /^[^:\\r\\n]+$/"},
		},
		{
			name:     "login page url",
			json:     `{"name":"api","origin":"https://login.example.test/signin?next=%2Fapp","auth":{"type":"login"}}`,
			messages: nil,
		},
		{
			name:     "card siteless",
			json:     `{"name":"api","auth":{"type":"card"}}`,
			messages: nil,
		},
		{
			name:     "name absent",
			json:     `{"origin":"https://example.test","auth":{"type":"bearer"}}`,
			messages: nil,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			_, _, messages := parseDestinationIssues(t, testCase.json, true)
			if strings.Join(messages, "|") != strings.Join(testCase.messages, "|") {
				t.Fatalf("issues = %q, want %q", messages, testCase.messages)
			}
		})
	}
}

// TestDestinationNamePresence checks that an omitted name and an empty one are told apart.
func TestDestinationNamePresence(t *testing.T) {
	_, hasName, messages := parseDestinationIssues(t, `{"origin":"https://example.test","auth":{"type":"bearer"}}`, true)
	if hasName || len(messages) != 0 {
		t.Fatalf("absent name: hasName=%v issues=%v", hasName, messages)
	}
	_, hasName, messages = parseDestinationIssues(t, `{"name":"","origin":"https://example.test","auth":{"type":"bearer"}}`, true)
	if hasName || len(messages) != 1 ||
		messages[0] != "Invalid string: must match pattern /^[a-z][a-z0-9_-]{0,63}$/" {
		t.Fatalf("empty name must fail the pattern: hasName=%v issues=%v", hasName, messages)
	}
	_, hasName, _ = parseDestinationIssues(t, `{"name":"api","origin":"https://example.test","auth":{"type":"bearer"}}`, true)
	if !hasName {
		t.Fatal("present name reported absent")
	}
}

func normalizeDestinationOf(t *testing.T, text string) (Destination, error) {
	t.Helper()
	destination, _, messages := parseDestinationIssues(t, text, true)
	if len(messages) != 0 {
		t.Fatalf("destination issues: %v", messages)
	}
	return normalizeDestination(destination)
}

// TestNormalizeDestinationRefusals is normalizeSecretDestination's joined message: the input
// schema accepts these, and the vault refuses them with the failing field named.
func TestNormalizeDestinationRefusals(t *testing.T) {
	cases := map[string]string{
		`{"name":"api","origin":"http://example.test","auth":{"type":"bearer"}}`:       "Invalid credential destination — origin: Expected an HTTPS origin without a path, credentials, query, or fragment",
		`{"name":"api","origin":"https://example.test/path","auth":{"type":"bearer"}}`: "Invalid credential destination — origin: Expected an HTTPS origin without a path, credentials, query, or fragment",
		`{"name":"api","origin":"https://u:p@example.test","auth":{"type":"bearer"}}`:  "Invalid credential destination — origin: Expected an HTTPS origin without a path, credentials, query, or fragment",
		// The origin schema rejects plain HTTP before the login rule can speak.
		`{"name":"api","origin":"http://login.example.test","auth":{"type":"login"}}`: "Invalid credential destination — origin: Expected an HTTPS origin without a path, credentials, query, or fragment",
		`{"name":"api","origin":"https://example.test","auth":{"type":"card"}}`:       "Invalid credential destination — origin: A card has no site; leave origin empty",
		`{"name":"api","origin":"https://example.test","auth":{"type":"command"}}`:    "Invalid credential destination — origin: A command variable has no site; leave origin empty",
	}
	for json, want := range cases {
		destination, _, messages := parseDestinationIssues(t, json, true)
		if len(messages) != 0 {
			t.Fatalf("%s: schema issues %v", json, messages)
		}
		_, err := normalizeDestination(destination)
		refusal, ok := asRefusal(err)
		if !ok || refusal.message != want {
			t.Fatalf("%s = %v, want %q", json, err, want)
		}
	}
}

func TestCanonicalLogin(t *testing.T) {
	destination, err := normalizeDestinationOf(t,
		`{"name":"login","origin":"https://login.example.test","auth":{"type":"login"}}`)
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name, value, want string
		wantError         string
	}{
		{
			name:  "trimmed labels and visible values",
			value: `{"fields":[{"label":" User ","value":"  alice  ","hidden":false}]}`,
			want:  `{"fields":[{"label":"User","value":"alice","hidden":false}]}`,
		},
		{
			name:  "hidden values keep their text",
			value: `{"fields":[{"label":"Password","value":"  p w  ","hidden":true}]}`,
			want:  `{"fields":[{"label":"Password","value":"  p w  ","hidden":true}]}`,
		},
		{
			name:  "legacy pair becomes two fields",
			value: `{"username":"  old  ","password":"  p  "}`,
			want:  `{"fields":[{"label":"Username","value":"old","hidden":false},{"label":"Password","value":"  p  ","hidden":true}]}`,
		},
		{
			name:  "otp is trimmed and kept",
			value: `{"fields":[{"label":"User","value":"u","hidden":false}],"otp":"jbsw y3dp ehpk 3pxp"}`,
			want:  `{"fields":[{"label":"User","value":"u","hidden":false}],"otp":"jbsw y3dp ehpk 3pxp"}`,
		},
		{
			name:      "otp must be readable",
			value:     `{"fields":[{"label":"User","value":"u"}],"otp":"123456"}`,
			wantError: "This authenticator key can't be read.",
		},
		{
			name:      "duplicate labels",
			value:     `{"fields":[{"label":"User","value":"a"},{"label":" user ","value":"b"}]}`,
			wantError: loginRefusal,
		},
		{
			name:      "empty visible value",
			value:     `{"fields":[{"label":"User","value":"   "}]}`,
			wantError: loginRefusal,
		},
		{
			name:      "not json",
			value:     "plain",
			wantError: loginRefusal,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got, err := canonicalValue(destination, testCase.value)
			if testCase.wantError != "" {
				if err == nil {
					t.Fatalf("canonical = %s, want error %q", got, testCase.wantError)
				}
				refusal, ok := asRefusal(err)
				if !ok || refusal.message != testCase.wantError {
					t.Fatalf("error = %v, want %q", err, testCase.wantError)
				}
				return
			}
			if err != nil {
				t.Fatalf("canonical: %v", err)
			}
			if got != testCase.want {
				t.Fatalf("canonical = %s, want %s", got, testCase.want)
			}
		})
	}
}

// TestRevealedLoginKeepsEmptyOTP checks the reveal shape against the stored canonical form.
func TestRevealedLoginKeepsEmptyOTP(t *testing.T) {
	stored := `{"fields":[{"label":"User","value":"u","hidden":false}],"otp":""}`
	revealed, err := decodeLogin(stored)
	if err != nil {
		t.Fatalf("decodeLogin: %v", err)
	}
	if revealed.OTP == nil || *revealed.OTP != "" {
		t.Fatalf("revealed otp = %v, want the empty string", revealed.OTP)
	}
	canonical, err := canonicalLogin(stored)
	if err != nil {
		t.Fatalf("canonicalLogin: %v", err)
	}
	if canonical != `{"fields":[{"label":"User","value":"u","hidden":false}]}` {
		t.Fatalf("canonical = %s", canonical)
	}
}

func TestCanonicalCard(t *testing.T) {
	destination, err := normalizeDestinationOf(t, `{"name":"card","auth":{"type":"card"}}`)
	if err != nil {
		t.Fatal(err)
	}
	got, err := canonicalValue(destination, `{"number":"4242 4242-4242 4242","expMonth":4,"expYear":2031,"cvc":" 123 ","name":" Alice "}`)
	if err != nil {
		t.Fatalf("canonical: %v", err)
	}
	want := `{"number":"4242424242424242","expMonth":4,"expYear":2031,"cvc":"123","name":"Alice"}`
	if got != want {
		t.Fatalf("canonical = %s, want %s", got, want)
	}
	for name, value := range map[string]string{
		"luhn":       `{"number":"4242424242424241","expMonth":4,"expYear":2031}`,
		"month":      `{"number":"4242424242424242","expMonth":13,"expYear":2031}`,
		"year":       `{"number":"4242424242424242","expMonth":4,"expYear":1999}`,
		"extra key":  `{"number":"4242424242424242","expMonth":4,"expYear":2031,"cvv":"1"}`,
		"cvc digits": `{"number":"4242424242424242","expMonth":4,"expYear":2031,"cvc":"12"}`,
		"not json":   `x`,
	} {
		if _, err := canonicalValue(destination, value); err == nil {
			t.Fatalf("%s: accepted %s", name, value)
		} else if refusal, ok := asRefusal(err); !ok || refusal.message != cardRefusal {
			t.Fatalf("%s: error = %v, want %q", name, err, cardRefusal)
		}
	}
}

func TestCanonicalContact(t *testing.T) {
	destination, err := normalizeDestinationOf(t, `{"name":"contact","auth":{"type":"contact"}}`)
	if err != nil {
		t.Fatal(err)
	}
	got, err := canonicalValue(destination, `{"name":"  Alice  ","email":"a@example.test"}`)
	if err != nil {
		t.Fatalf("canonical: %v", err)
	}
	if got != `{"name":"Alice","email":"a@example.test"}` {
		t.Fatalf("canonical = %s", got)
	}
	if _, err := canonicalValue(destination, `{"name":"  "}`); err == nil {
		t.Fatal("empty contact accepted")
	}
	if _, err := canonicalValue(destination, `{"name":"A","phone":"1","bad":2}`); err == nil {
		t.Fatal("unknown contact key accepted")
	}
}

func TestHeaderValueRefusals(t *testing.T) {
	bearer := Auth{Type: "bearer"}
	for name, value := range map[string]string{
		"nul":          "a\x00b",
		"cr":           "a\rb",
		"lf":           "a\nb",
		"latin1":       "a\xffb",
		"wide":         "日本",
		"trailing tab": "value\t",
		"surrogate":    "a\xed\xa0\x80b",
	} {
		if err := headerValue(bearer, value); err == nil {
			t.Fatalf("%s: accepted %q", name, value)
		}
	}
	if err := headerValue(bearer, "plain value"); err != nil {
		t.Fatalf("plain value: %v", err)
	}
	// A bearer value may begin with a space: only the built header's ends matter.
	if err := headerValue(bearer, " value"); err != nil {
		t.Fatalf("bearer leading space: %v", err)
	}
	if err := headerValue(Auth{Type: "header", Name: "X-Api-Key"}, " value"); err == nil {
		t.Fatal("a header value with a leading space was accepted")
	}
	if err := headerValue(Auth{Type: "basic", Username: "a:b"}, "x"); err != nil {
		t.Fatalf("basic username is checked by the destination, not the header: %v", err)
	}
}

func TestNewVaultItemNameSlug(t *testing.T) {
	// The slug is what newVaultItemName derives before its free-name search.
	cases := map[string]string{
		"Café  Card!!":       "cafe-card",
		"  Hello__World  ":   "hello-world",
		"123 leading digits": "leading-digits",
		"trailing---":        "trailing",
		"":                   "",
	}
	for base, want := range cases {
		got := slugFor(base)
		if got != want {
			t.Fatalf("slug(%q) = %q, want %q", base, got, want)
		}
	}
	if got := slugFor(strings.Repeat("a", 80)); len(got) != 56 {
		t.Fatalf("long slug = %d units", len(got))
	}
}

// TestGateCorpus is the accepted side of the redaction gate's differential corpus: the harness
// (contract-m-secrets.mts's gate cases) proves each of these names reaches the audit row
// byte-identical through the real TypeScript redactor.
func TestGateCorpus(t *testing.T) {
	for _, name := range []string{"a.b_c-d", "sken", "api-key", "my_key.v2", "credentials", "example-2"} {
		if !effects.AuditedMetadataServable(name) {
			t.Fatalf("gate refuses %q, which the corpus shows the redactor leaves unchanged", name)
		}
	}
	for _, name := range []string{"sk-abc", "sk_9", "my-sk-key", "ak_x", "ck_x", "eyJhbGci", "with space", "@example.test", "a/b"} {
		if effects.AuditedMetadataServable(name) {
			t.Fatalf("gate accepts %q", name)
		}
	}
	// The 200-unit cut runs before redaction, so a long safe prefix with a key after the cut is
	// stored as the cut text on both sides.
	long := strings.Repeat("a", 200) + "sk-abc"
	if !effects.AuditedMetadataServable(long) {
		t.Fatal("gate refused a value whose key is past the 200-unit cut")
	}
}

// slugFor is newVaultItemName's slug step, without the database search.
func slugFor(base string) string {
	return newVaultItemNameSlug(base)
}
