package marketplace

import (
	"errors"
	"regexp"
	"strings"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/whatwgurl"
)

// SourceRef is PluginSourceRef: the HTTPS git URL plus the optional ref and subdirectory.
type SourceRef struct {
	GitURL string
	Ref    *string
	Subdir *string
}

var (
	treePath = regexp.MustCompile(`^/([^/]+)/([^/]+)/tree/([^/]+)(?:/(.+))?$`)
	repoPath = regexp.MustCompile(`^/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)
)

// ParseSource is parsePluginSource (packages/adapters/src/integrations/plugin-connectors.ts:151):
// `https://host/owner/repo[.git][@ref][#subdir]`, with GitHub's `/tree/ref/subdir` form
// accepted for a single-segment ref. The URL parser does the same normalization as the
// TypeScript `new URL` call.
func ParseSource(source string) (SourceRef, error) {
	input := validate.JSTrim(source)
	if input == "" || shared.UTF16Length(input) > 2048 {
		return SourceRef{}, errors.New("Plugin source must be an HTTPS git URL")
	}
	u, err := whatwgurl.Parse(input)
	if err != nil {
		return SourceRef{}, errors.New("Plugin source must be an HTTPS git URL")
	}
	if u.Protocol() != "https:" {
		return SourceRef{}, errors.New("Plugin source must use HTTPS")
	}
	if u.Username() != "" || u.Password() != "" {
		return SourceRef{}, errors.New("Plugin source must not contain credentials")
	}
	if u.Search() != "" || u.Port() != "" {
		return SourceRef{}, errors.New("Plugin source must not contain a query or custom port")
	}

	hash := u.Hash()
	subdirFromHash := strings.TrimPrefix(hash, "#")
	u.SetHash("")
	path := strings.TrimSuffix(u.Pathname(), "/")
	ref := ""
	hasRef := false
	if at := strings.IndexByte(path, '@'); at >= 0 {
		ref, hasRef = path[at+1:], true
		path = path[:at]
	}
	subdir := subdirFromHash
	hasSubdir := subdir != ""
	if u.Hostname() == "github.com" {
		if match := treePath.FindStringSubmatch(path); match != nil {
			path = "/" + match[1] + "/" + match[2]
			if !hasRef {
				ref, hasRef = match[3], true
			}
			if !hasSubdir && match[4] != "" {
				subdir, hasSubdir = match[4], true
			}
		}
	}
	path = strings.TrimSuffix(path, ".git")
	if !repoPath.MatchString(path) {
		return SourceRef{}, errors.New("Plugin source must identify an owner and repository")
	}
	for _, segment := range strings.Split(path, "/") {
		if segment == "." || segment == ".." {
			return SourceRef{}, errors.New("Plugin source must identify an owner and repository")
		}
	}
	if hasRef && (ref == "" || shared.UTF16Length(ref) > 200 || strings.Contains(ref, "..") ||
		strings.ContainsAny(ref, "%#?\\") || hasJSSpace(ref) || hasControlCharacters(ref)) {
		return SourceRef{}, errors.New("Plugin ref is invalid")
	}
	if hasSubdir && !safePath(subdir) {
		return SourceRef{}, errors.New("Plugin paths must stay inside the plugin directory")
	}
	if u.Hostname() == "github.com" {
		u.SetPathname(strings.ToLower(path))
	} else {
		u.SetPathname(path)
	}
	result := SourceRef{GitURL: strings.TrimSuffix(u.String(), "/")}
	if hasRef {
		result.Ref = &ref
	}
	if hasSubdir {
		result.Subdir = &subdir
	}
	return result, nil
}

// browseURL is browseUrl: a repository with a ref or subdirectory opens at that tree in GitHub.
func browseURL(source string) (string, error) {
	ref, err := ParseSource(source)
	if err != nil {
		return "", err
	}
	if ref.Ref != nil || ref.Subdir != nil {
		at := "HEAD"
		if ref.Ref != nil {
			at = *ref.Ref
		}
		url := ref.GitURL + "/tree/" + at
		if ref.Subdir != nil {
			url += "/" + *ref.Subdir
		}
		return url, nil
	}
	return ref.GitURL, nil
}

func safePath(path string) bool {
	if path == "" || strings.HasPrefix(path, "/") || strings.Contains(path, "\\") ||
		strings.Contains(path, "%") || strings.ContainsAny(path, "#?") || hasControlCharacters(path) {
		return false
	}
	for _, segment := range strings.Split(path, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return false
		}
	}
	return true
}

// hasControlCharacters is [...]charCodeAt(0) < 32 || === 127.
func hasControlCharacters(value string) bool {
	for _, character := range value {
		if character < 32 || character == 127 {
			return true
		}
	}
	return false
}

// hasJSSpace is the ECMAScript \s class used by /[%#?\\\s]/.
func hasJSSpace(value string) bool {
	for _, character := range value {
		if validate.IsJSSpace(character) {
			return true
		}
	}
	return false
}
