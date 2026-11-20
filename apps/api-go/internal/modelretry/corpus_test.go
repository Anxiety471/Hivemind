package modelretry

import (
	"encoding/json"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"
)

type corpusFile struct {
	Now   int64        `json:"now"`
	Cases []corpusCase `json:"cases"`
}

type corpusCase struct {
	Text                 string `json:"text"`
	Provider             string `json:"provider"`
	PrimaryProvider      string `json:"primaryProvider"`
	FailedAfterAccepting bool   `json:"failedAfterAccepting"`
	RequestLimitTooSmall bool   `json:"requestLimitTooSmall"`
	Class                string `json:"class"`
	Transient            bool   `json:"transient"`
	ProviderUnavailable  bool   `json:"providerUnavailable"`
	CredentialRejected   bool   `json:"credentialRejected"`
	ContentFilter        bool   `json:"contentFilter"`
	Permanent            bool   `json:"permanent"`
	Status               *int   `json:"status"`
	Unrecognized         bool   `json:"unrecognized"`
	UnrecognizedStatus   *int   `json:"unrecognizedStatus"`
	ComputerAllowance    bool   `json:"computerAllowanceUsed"`
	QuotaResetAt         *int64 `json:"quotaResetAt"`
	SwitchToBackup       bool   `json:"switchToBackup"`
	RetrySameModel       bool   `json:"retrySameModel"`
}

func TestCorpusMatchesTypeScript(t *testing.T) {
	t.Parallel()

	encoded, err := os.ReadFile("testdata/corpus.json")
	if err != nil {
		t.Fatalf("reading corpus: %v", err)
	}
	var corpus corpusFile
	if err := json.Unmarshal(encoded, &corpus); err != nil {
		t.Fatalf("decoding corpus: %v", err)
	}
	if len(corpus.Cases) == 0 {
		t.Fatal("corpus has no cases")
	}
	now := time.UnixMilli(corpus.Now)
	for index, testCase := range corpus.Cases {
		text := testCase.Text
		provider := testCase.Provider
		prefix := "case " + strconv.Itoa(index) + " (" + firstLine(text) + ", provider=" + provider + "): "
		if got := Failure(text, provider, testCase.PrimaryProvider, testCase.FailedAfterAccepting).String(); got != testCase.Class {
			t.Fatalf("%sFailure class = %s, want %s", prefix, got, testCase.Class)
		}
		if got := IsTransient(text); got != testCase.Transient {
			t.Fatalf("%sIsTransient = %t, want %t", prefix, got, testCase.Transient)
		}
		if got := IsRetryableProviderUnavailable(text); got != testCase.ProviderUnavailable {
			t.Fatalf("%sIsRetryableProviderUnavailable = %t, want %t", prefix, got, testCase.ProviderUnavailable)
		}
		if got := IsCredentialRejected(text); got != testCase.CredentialRejected {
			t.Fatalf("%sIsCredentialRejected = %t, want %t", prefix, got, testCase.CredentialRejected)
		}
		if got := IsContentFilterRejection(text); got != testCase.ContentFilter {
			t.Fatalf("%sIsContentFilterRejection = %t, want %t", prefix, got, testCase.ContentFilter)
		}
		if got := NamesPermanentFailure(text); got != testCase.Permanent {
			t.Fatalf("%sNamesPermanentFailure = %t, want %t", prefix, got, testCase.Permanent)
		}
		status, hasStatus := Status(text)
		if hasStatus != (testCase.Status != nil) {
			t.Fatalf("%sStatus presence = %t, want %t", prefix, hasStatus, testCase.Status != nil)
		}
		if hasStatus && status != *testCase.Status {
			t.Fatalf("%sStatus = %d, want %d", prefix, status, *testCase.Status)
		}
		unrecognized, ok := UnrecognizedFailure(text, provider)
		if ok != testCase.Unrecognized {
			t.Fatalf("%sUnrecognizedFailure ok = %t, want %t", prefix, ok, testCase.Unrecognized)
		}
		if ok {
			if unrecognized.HasStatus != (testCase.UnrecognizedStatus != nil) {
				t.Fatalf("%sunrecognized status presence = %t, want %t", prefix, unrecognized.HasStatus, testCase.UnrecognizedStatus != nil)
			}
			if unrecognized.HasStatus && unrecognized.Status != *testCase.UnrecognizedStatus {
				t.Fatalf("%sunrecognized status = %d, want %d", prefix, unrecognized.Status, *testCase.UnrecognizedStatus)
			}
		}
		decision := Decide(text, provider, testCase.RequestLimitTooSmall)
		if decision.SwitchToBackup != testCase.SwitchToBackup || decision.RetrySameModel != testCase.RetrySameModel {
			t.Fatalf("%sDecide = %+v, want {SwitchToBackup:%t RetrySameModel:%t}", prefix, decision, testCase.SwitchToBackup, testCase.RetrySameModel)
		}
		if got := IsComputerAllowanceUsed(text); got != testCase.ComputerAllowance {
			t.Fatalf("%sIsComputerAllowanceUsed = %t, want %t", prefix, got, testCase.ComputerAllowance)
		}
		resetAt, reset := ProviderQuotaResetAt(text, now)
		if reset != (testCase.QuotaResetAt != nil) {
			t.Fatalf("%sProviderQuotaResetAt presence = %t, want %t", prefix, reset, testCase.QuotaResetAt != nil)
		}
		if reset && resetAt.UnixMilli() != *testCase.QuotaResetAt {
			t.Fatalf("%sProviderQuotaResetAt = %d, want %d", prefix, resetAt.UnixMilli(), *testCase.QuotaResetAt)
		}
	}
}

func TestClassNames(t *testing.T) {
	t.Parallel()

	cases := map[Class]string{
		ClassTransient:     "transient",
		ClassOutput:        "output",
		ClassContentFilter: "content-filter",
		ClassAccount:       "account",
		ClassServer:        "server",
	}
	for class, want := range cases {
		if got := class.String(); got != want {
			t.Errorf("Class(%d).String() = %q, want %q", class, got, want)
		}
	}
}

func firstLine(text string) string {
	if index := strings.IndexByte(text, '\n'); index >= 0 {
		text = text[:index]
	}
	if len(text) > 80 {
		return text[:80] + "…"
	}
	return text
}
