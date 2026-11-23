package marketplace

import "testing"

func TestParseSourceMatchesPluginSourceRefs(t *testing.T) {
	ref := "feature/plugins"
	one := "one"
	main := "main"
	sub := "one"
	for source, want := range map[string]SourceRef{
		"https://github.com/example/plugins": {GitURL: "https://github.com/example/plugins"},
		"https://github.com/Example/Plugins": {GitURL: "https://github.com/example/plugins"},
		"https://github.com/example/plugins.git@feature/plugins#one": {
			GitURL: "https://github.com/example/plugins", Ref: &ref, Subdir: &sub,
		},
		"https://github.com/example/plugins/tree/main/one": {
			GitURL: "https://github.com/example/plugins", Ref: &main, Subdir: &one,
		},
	} {
		got, err := ParseSource(source)
		if err != nil {
			t.Errorf("ParseSource(%q) failed: %v", source, err)
			continue
		}
		if got.GitURL != want.GitURL || pointer(got.Ref) != pointer(want.Ref) || pointer(got.Subdir) != pointer(want.Subdir) {
			t.Errorf("ParseSource(%q) = %+v, want %+v", source, got, want)
		}
	}
}

func pointer(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func TestParseSourceRejectsUnsafeSources(t *testing.T) {
	for _, source := range []string{
		"http://github.com/a/b",
		"https://user:password@github.com/a/b",
		"https://github.com/a/b?token=secret",
		"https://github.com/a/b#../escape",
		"https://github.com/a/b#dir\\file",
		"https://github.com/a/b#%2e%2e/escape",
		"https://github.com/a/b#one#two",
		"not a url",
		"https://github.com:444/a/b",
	} {
		if _, err := ParseSource(source); err == nil {
			t.Errorf("ParseSource(%q) succeeded", source)
		}
	}
}

func TestBrowseURLUsesTheRefAndSubdir(t *testing.T) {
	for source, want := range map[string]string{
		"https://github.com/example/plugins":                         "https://github.com/example/plugins",
		"https://github.com/example/plugins@main":                    "https://github.com/example/plugins/tree/main",
		"https://github.com/example/plugins/tree/main/one":           "https://github.com/example/plugins/tree/main/one",
		"https://github.com/example/plugins@feature/plugins#sub/dir": "https://github.com/example/plugins/tree/feature/plugins/sub/dir",
	} {
		got, err := browseURL(source)
		if err != nil {
			t.Errorf("browseURL(%q) failed: %v", source, err)
			continue
		}
		if got != want {
			t.Errorf("browseURL(%q) = %q, want %q", source, got, want)
		}
	}
}
