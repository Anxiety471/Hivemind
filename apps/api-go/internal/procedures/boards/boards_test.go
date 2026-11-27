package boards

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/tickets"
)

func input(text string) orpc.Input { return orpc.Input{Raw: json.RawMessage(text)} }

// messagesOf flattens a validation failure's zod-style issues to their messages.
func messagesOf(t *testing.T, failure *orpc.Error) []string {
	t.Helper()
	body, err := json.Marshal(failure.Data)
	if err != nil {
		t.Fatal(err)
	}
	var envelope struct {
		Issues []struct {
			Message string `json:"message"`
		} `json:"issues"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		t.Fatalf("issues = %s: %v", body, err)
	}
	out := make([]string, 0, len(envelope.Issues))
	for _, issue := range envelope.Issues {
		out = append(out, issue.Message)
	}
	return out
}

func TestParseRenameAcceptsRepositoriesAlone(t *testing.T) {
	parsed, failure := parse(input(`{"repositories":[]}`))
	if failure != nil || !parsed.hasRepositories || len(parsed.repositories) != 0 {
		t.Fatalf("parsed = %+v failure = %v", parsed, failure)
	}
}

func TestParseRenameRequiresAField(t *testing.T) {
	_, failure := parse(input(`{}`))
	if failure == nil || failure.Message != "Input validation failed" {
		t.Fatalf("failure = %+v", failure)
	}
	if got := messagesOf(t, failure); len(got) != 1 || got[0] != "Provide a name or ticketPrefix" {
		t.Fatalf("messages = %q", got)
	}
}

func TestParseRenameNormalizesRepositories(t *testing.T) {
	parsed, failure := parse(input(`{"repositories":[
		{"url":" HTTPS://GitHub.com/Acme/App.git ","aliases":[" Web ","web","  api"],"isDefault":true},
		{"url":"https://github.com/acme/app","aliases":["other"],"isDefault":true},
		{"url":"https://gitlab.com/g/a/b","isDefault":true}
	]}`))
	if failure != nil {
		t.Fatalf("failure = %v", messagesOf(t, failure))
	}
	want := []BoardRepository{
		{URL: "https://github.com/acme/app", Aliases: []string{"Web", "api"}, IsDefault: true},
		{URL: "https://gitlab.com/g/a/b", Aliases: []string{}, IsDefault: false},
	}
	if got := parsed.repositories; len(got) != len(want) || got[0].URL != want[0].URL ||
		!equalStrings(got[0].Aliases, want[0].Aliases) || !got[0].IsDefault ||
		got[1].URL != want[1].URL || got[1].IsDefault || len(got[1].Aliases) != 0 {
		t.Fatalf("repositories = %+v, want %+v", got, want)
	}
}

func TestParseRenameRejectsBadRepositories(t *testing.T) {
	cases := map[string]struct {
		text string
		want string
	}{
		"not a repository link": {
			`{"repositories":[{"url":"https://github.com/acme/app/pull/12"}]}`,
			"Use a repository link such as https://example.com/owner/repo.",
		},
		"alias with a tab": {
			`{"repositories":[{"url":"https://github.com/acme/app","aliases":["a\tb"]}]}`,
			"Alias cannot contain line breaks",
		},
		"alias with a newline": {
			`{"repositories":[{"url":"https://github.com/acme/app","aliases":["a\nb"]}]}`,
			"Alias cannot contain line breaks",
		},
		"blank alias": {
			`{"repositories":[{"url":"https://github.com/acme/app","aliases":["   "]}]}`,
			"Too small: expected string to have >=1 characters",
		},
		"alias too long": {
			`{"repositories":[{"url":"https://github.com/acme/app","aliases":["` + strings.Repeat("a", aliasMaxLength+1) + `"]}]}`,
			"Too big: expected string to have <=40 characters",
		},
		"too many aliases": {
			`{"repositories":[{"url":"https://github.com/acme/app","aliases":[` + strings.TrimSuffix(strings.Repeat(`"a",`, maxAliases+1), ",") + `]}]}`,
			"Too big: expected array to have <=10 items",
		},
		"too many repositories": {
			`{"repositories":[` + strings.TrimSuffix(strings.Repeat(`{"url":"https://github.com/a/b"},`, maxRepositories+1), ",") + `]}`,
			"Too big: expected array to have <=20 items",
		},
		"missing url": {
			`{"repositories":[{"aliases":[]}]}`,
			"Invalid input: expected string, received undefined",
		},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			_, failure := parse(input(tc.text))
			if failure == nil {
				t.Fatalf("parse(%s) accepted", tc.text)
			}
			got := messagesOf(t, failure)
			if len(got) == 0 || !containsString(got, tc.want) {
				t.Fatalf("messages = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestNormalizeRepositoriesDedupesLikeTheContract(t *testing.T) {
	got := normalizeRepositories([]repositoryInput{
		{url: "https://github.com/a/one", aliases: []string{"Alpha", "alpha", "BETA"}, isDefault: true},
		{url: "https://github.com/a/one", aliases: []string{"ignored"}},
		{url: "https://github.com/a/two", isDefault: true},
	})
	if len(got) != 2 {
		t.Fatalf("got %+v, want two repositories", got)
	}
	if !equalStrings(got[0].Aliases, []string{"Alpha", "BETA"}) || !got[0].IsDefault {
		t.Fatalf("first = %+v", got[0])
	}
	if got[1].IsDefault {
		t.Fatalf("a second default was kept: %+v", got[1])
	}
}

func TestNormalizeRepositoriesCapsTheList(t *testing.T) {
	input := make([]repositoryInput, 0, maxRepositories+5)
	for i := range maxRepositories + 5 {
		input = append(input, repositoryInput{url: "https://github.com/a/r" + string(rune('a'+i))})
	}
	if got := normalizeRepositories(input); len(got) != maxRepositories {
		t.Fatalf("len = %d, want %d", len(got), maxRepositories)
	}
}

func TestBoardDTOMarshalsEmptyListsAsArrays(t *testing.T) {
	body, err := json.Marshal(dto(tickets.Board{ID: "b", SpaceID: "s", Prefix: "TASK", Repositories: []byte(`[]`)}))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), `"repositories":[]`) {
		t.Fatalf("body = %s", body)
	}
	body, err = json.Marshal(dto(tickets.Board{ID: "b", SpaceID: "s", Prefix: "TASK", Repositories: []byte(`not json`)}))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), `"repositories":[]`) {
		t.Fatalf("unreadable stored value body = %s", body)
	}
}

func TestBoardDTOCarriesStoredRepositories(t *testing.T) {
	stored := []byte(`[{"url":"https://github.com/a/b","aliases":[],"isDefault":true,"extra":1},{"url":"https://github.com/c/d","aliases":["x"],"isDefault":false}]`)
	body, err := json.Marshal(dto(tickets.Board{ID: "b", SpaceID: "s", Prefix: "TASK", Repositories: stored}))
	if err != nil {
		t.Fatal(err)
	}
	want := `"repositories":[{"url":"https://github.com/a/b","aliases":[],"isDefault":true},{"url":"https://github.com/c/d","aliases":["x"],"isDefault":false}]`
	if !strings.Contains(string(body), want) {
		t.Fatalf("body = %s", body)
	}
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func containsString(list []string, want string) bool {
	for _, item := range list {
		if item == want {
			return true
		}
	}
	return false
}
