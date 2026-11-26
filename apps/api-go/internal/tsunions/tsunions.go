// Package tsunions reads the string-literal tables TypeScript declares in this repository, so a
// Go test can prove a table it mirrors has not drifted. It reads source text (never a build
// artifact), so the check needs no node, no install and no generated output.
//
// A discriminated union is resolved through the schema references its variants use — MessageBlock
// lists `ToolCardSchema` rather than spelling out `kind: z.literal("job")` — by looking the name
// up in the same file and then across packages/contracts/src. Every step that cannot resolve a
// variant is an error: a guard that silently skipped an unreadable variant would pass while the
// gap it exists to catch stayed open.
package tsunions

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// File is one TypeScript source file with its comments blanked out, so a kind named only in a
// comment is never read as declared.
type File struct {
	// Path is the file's path from the repository root, with forward slashes.
	Path string
	root string
	text string
}

// Root finds the repository root by walking up from the working directory until the contracts
// package is there. Tests fail rather than skip when it is missing: the guard has no meaning
// outside the checkout whose TypeScript it mirrors.
func Root() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "packages", "contracts", "src", "threads", "message-blocks.ts")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("no repository root above %s: packages/contracts/src/threads/message-blocks.ts not found", dir)
		}
		dir = parent
	}
}

// Open reads a file named from the repository root.
func Open(root, path string) (*File, error) {
	raw, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(path)))
	if err != nil {
		return nil, err
	}
	return &File{Path: path, root: root, text: stripComments(string(raw))}, nil
}

// Union is a z.discriminatedUnion's variant names, in declaration order, keyed by `discriminator`.
// name is the const that holds the union (MessageBlock); the variants may name other schemas.
func (f *File) Union(name, discriminator string) ([]string, error) {
	body, err := f.declarationArray(name, "discriminatedUnion")
	if err != nil {
		return nil, err
	}
	var kinds []string
	seen := map[string]bool{}
	for _, entry := range splitTopLevel(body) {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		found, err := f.entryKinds(entry, discriminator)
		if err != nil {
			return nil, fmt.Errorf("%s: variant %q: %w", f.Path, firstLine(entry), err)
		}
		for _, kind := range found {
			if seen[kind] {
				return nil, fmt.Errorf("%s: %s lists %q twice", f.Path, name, kind)
			}
			seen[kind] = true
			kinds = append(kinds, kind)
		}
	}
	if len(kinds) == 0 {
		return nil, fmt.Errorf("%s: %s has no variants", f.Path, name)
	}
	return kinds, nil
}

// Strings is the string literals of the array a const is assigned: a `new Set<string>([...])`
// table, a `z.enum([...])`, or a plain array. It reads no names, only the literals written.
func (f *File) Strings(name string) ([]string, error) {
	body, err := f.declarationArray(name, "")
	if err != nil {
		return nil, err
	}
	values, err := literals(body)
	if err != nil {
		return nil, fmt.Errorf("%s: %s: %w", f.Path, name, err)
	}
	if len(values) == 0 {
		return nil, fmt.Errorf("%s: %s has no string literals", f.Path, name)
	}
	return values, nil
}

// TypeFilters is every `type: { in: [ ... ] }` array in the file, in source order. It reads the
// inline event-type filters a query is written with, which no named const holds.
func (f *File) TypeFilters() ([][]string, error) {
	pattern := regexp.MustCompile(`\btype\s*:\s*\{\s*in\s*:\s*\[`)
	matches := pattern.FindAllStringIndex(f.text, -1)
	out := make([][]string, 0, len(matches))
	for _, match := range matches {
		body, _, err := span(f.text, match[1]-1)
		if err != nil {
			return nil, fmt.Errorf("%s: type filter at offset %d: %w", f.Path, match[0], err)
		}
		values, err := literals(body)
		if err != nil {
			return nil, fmt.Errorf("%s: type filter at offset %d: %w", f.Path, match[0], err)
		}
		out = append(out, values)
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("%s: no `type: { in: [...] }` filter", f.Path)
	}
	return out, nil
}

// declarationArray returns the array body of a const: the first `[` after its `=`. marker, when
// set, must appear between the `=` and that `[` (it names the schema function the array belongs
// to, so the wrong array is a loud error rather than a wrong answer).
func (f *File) declarationArray(name, marker string) (string, error) {
	declaration, err := regexp.Compile(`\bconst\s+` + regexp.QuoteMeta(name) + `\s*(?::[^=;\n]*)?=`)
	if err != nil {
		return "", err
	}
	at := declaration.FindStringIndex(f.text)
	if at == nil {
		return "", fmt.Errorf("%s: no `const %s`", f.Path, name)
	}
	rest := f.text[at[1]:]
	open := strings.IndexByte(rest, '[')
	if open < 0 {
		return "", fmt.Errorf("%s: %s is not an array", f.Path, name)
	}
	if marker != "" {
		fn := regexp.MustCompile(`\.\s*` + regexp.QuoteMeta(marker) + `\s*\(`)
		if fn.FindStringIndex(rest[:open]) == nil {
			return "", fmt.Errorf("%s: %s is not a %s(...) array", f.Path, name, marker)
		}
	}
	body, _, err := span(rest, open)
	return body, err
}

// entryKinds is the kind names one variant declares. A variant is either a `z.object({...})` that
// names its discriminator, or an identifier standing for such a schema elsewhere.
func (f *File) entryKinds(entry, discriminator string) ([]string, error) {
	if isIdentifier(entry) {
		definition, path, err := f.definition(entry)
		if err != nil {
			return nil, err
		}
		if kinds, ok := literalsFor(definition, discriminator); ok {
			return kinds, nil
		}
		// A referenced union holds one kind per variant of its own.
		if nested := strings.Index(definition, "discriminatedUnion"); nested >= 0 {
			open := strings.IndexByte(definition[nested:], '[')
			if open >= 0 {
				body, _, err := span(definition[nested:], open)
				if err != nil {
					return nil, err
				}
				var kinds []string
				for _, inner := range splitTopLevel(body) {
					found, err := f.entryKinds(strings.TrimSpace(inner), discriminator)
					if err != nil {
						return nil, err
					}
					kinds = append(kinds, found...)
				}
				return kinds, nil
			}
		}
		return nil, fmt.Errorf("%s (resolved to %s) declares no %q literal", entry, path, discriminator)
	}
	if kinds, ok := literalsFor(entry, discriminator); ok {
		return kinds, nil
	}
	return nil, fmt.Errorf("not a schema this reader understands")
}

// definition finds where a schema name is declared: this file first, then every TypeScript file
// under packages/contracts/src in sorted order.
func (f *File) definition(name string) (string, string, error) {
	if definition, ok := declarationBody(f.text, name); ok {
		return definition, f.Path, nil
	}
	base := filepath.Join(f.root, "packages", "contracts", "src")
	var files []string
	err := filepath.WalkDir(base, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !entry.IsDir() && strings.HasSuffix(path, ".ts") {
			files = append(files, path)
		}
		return nil
	})
	if err != nil {
		return "", "", err
	}
	sort.Strings(files)
	for _, path := range files {
		raw, err := os.ReadFile(path)
		if err != nil {
			return "", "", err
		}
		if definition, ok := declarationBody(stripComments(string(raw)), name); ok {
			relative, _ := filepath.Rel(f.root, path)
			return definition, filepath.ToSlash(relative), nil
		}
	}
	return "", "", fmt.Errorf("%s is not declared under packages/contracts/src", name)
}

// declarationBody is a const's schema value: from its `=` through the bracket that closes the
// first object, array or call in it, so a later declaration in the same file is not mistaken for
// part of this one.
func declarationBody(text, name string) (string, bool) {
	declaration := regexp.MustCompile(`\b(?:export\s+)?const\s+` + regexp.QuoteMeta(name) + `\s*(?::[^=;\n]*)?=`)
	at := declaration.FindStringIndex(text)
	if at == nil {
		return "", false
	}
	rest := text[at[1]:]
	open := strings.IndexAny(rest, "[{(")
	if open < 0 {
		return rest, true
	}
	_, end, err := span(rest, open)
	if err != nil {
		return rest, true
	}
	return rest[:end+1], true
}

// literalsFor is every `<discriminator>: z.literal("...")` in a schema body, as written.
func literalsFor(body, discriminator string) ([]string, bool) {
	pattern := regexp.MustCompile(`\b` + regexp.QuoteMeta(discriminator) + `\s*:\s*z\s*\.\s*literal\s*\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*\)`)
	var kinds []string
	for _, match := range pattern.FindAllStringSubmatch(body, -1) {
		kinds = append(kinds, unquote(match[1]))
	}
	return kinds, len(kinds) > 0
}

// literals is every string literal of an array body, unquoted.
func literals(body string) ([]string, error) {
	var out []string
	for _, entry := range splitTopLevel(body) {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		if entry[0] != '"' && entry[0] != '\'' {
			return nil, fmt.Errorf("entry %q is not a string literal", firstLine(entry))
		}
		end, err := stringEnd(entry, 0)
		if err != nil {
			return nil, err
		}
		if rest := strings.TrimSpace(entry[end+1:]); rest != "" {
			return nil, fmt.Errorf("entry %q has trailing text", firstLine(entry))
		}
		out = append(out, unquote(entry[:end+1]))
	}
	return out, nil
}

// span returns the text between an opening bracket and its match, and the closing index.
func span(text string, open int) (string, int, error) {
	if open < 0 || open >= len(text) || (text[open] != '[' && text[open] != '{' && text[open] != '(') {
		return "", 0, fmt.Errorf("no opening bracket at offset %d", open)
	}
	depth := 0
	for index := open; index < len(text); index++ {
		switch text[index] {
		case '"', '\'', '`':
			end, err := stringEnd(text, index)
			if err != nil {
				return "", 0, err
			}
			index = end
		case '[', '{', '(':
			depth++
		case ']', '}', ')':
			depth--
			if depth == 0 {
				return text[open+1 : index], index, nil
			}
		}
	}
	return "", 0, fmt.Errorf("unbalanced bracket from offset %d", open)
}

// splitTopLevel is an array or argument list's entries, split at commas outside brackets, braces,
// parentheses and strings.
func splitTopLevel(body string) []string {
	var out []string
	depth, start := 0, 0
	for index := 0; index < len(body); index++ {
		switch body[index] {
		case '"', '\'', '`':
			end, err := stringEnd(body, index)
			if err != nil {
				out = append(out, body[start:])
				return out
			}
			index = end
		case '[', '{', '(':
			depth++
		case ']', '}', ')':
			depth--
		case ',':
			if depth == 0 {
				out = append(out, body[start:index])
				start = index + 1
			}
		}
	}
	if tail := strings.TrimSpace(body[start:]); tail != "" {
		out = append(out, body[start:])
	}
	return out
}

// stringEnd is the index of the quote closing the literal that starts at open.
func stringEnd(text string, open int) (int, error) {
	quote := text[open]
	for index := open + 1; index < len(text); index++ {
		switch text[index] {
		case '\\':
			index++
		case quote:
			return index, nil
		}
	}
	return 0, fmt.Errorf("unterminated string at offset %d", open)
}

// unquote reads a TypeScript string literal with the escapes a kind name can carry.
func unquote(literal string) string {
	body := literal[1 : len(literal)-1]
	if !strings.Contains(body, `\`) {
		return body
	}
	replacer := strings.NewReplacer(`\\`, `\`, `\"`, `"`, `\'`, `'`, `\n`, "\n", `\t`, "\t")
	return replacer.Replace(body)
}

// stripComments blanks out comments and regular-expression bodies, keeping offsets and newlines,
// and leaves string contents alone so a URL in a literal is not mistaken for a comment. A regex
// is blanked because a pattern may carry a quote or a bracket (`/^[^']+$/`), which would otherwise
// read as a string or a nested array to the parser that runs after this pass.
func stripComments(source string) string {
	out := []byte(source)
	var previous byte
	for index := 0; index < len(source); index++ {
		switch source[index] {
		case '"', '\'', '`':
			end, err := stringEnd(source, index)
			if err != nil {
				return string(out)
			}
			index = end
			previous = source[index]
		case '/':
			if index+1 >= len(source) {
				continue
			}
			switch {
			case source[index+1] == '/':
				for index < len(source) && source[index] != '\n' {
					out[index] = ' '
					index++
				}
			case source[index+1] == '*':
				for index < len(source) && !(source[index] == '*' && index+1 < len(source) && source[index+1] == '/') {
					if source[index] != '\n' {
						out[index] = ' '
					}
					index++
				}
				if index < len(source) {
					out[index] = ' '
					if index+1 < len(source) {
						out[index+1] = ' '
						index++
					}
				}
			case source[index+1] != '=' && regexStart(previous):
				if end := regexEnd(source, index); end > 0 {
					for inner := index + 1; inner < end; inner++ {
						if source[inner] != '\n' {
							out[inner] = ' '
						}
					}
					index = end
				}
			}
		default:
			if !isSpace(source[index]) {
				previous = source[index]
			}
		}
	}
	return string(out)
}

// regexStart reports whether a `/` right after previous begins a regex rather than a division: an
// operand ends with an identifier character, `)`, `]` or a digit, so anything else expecting a
// value can be followed by a pattern.
func regexStart(previous byte) bool {
	switch previous {
	case '(', '[', '=', ',', ':', '!', '&', '|', '?', '{', ';', '\n', 0:
		return true
	}
	return false
}

// regexEnd is the index of the `/` closing the pattern that starts at open, or -1.
func regexEnd(source string, open int) int {
	inClass := false
	for index := open + 1; index < len(source); index++ {
		switch source[index] {
		case '\\':
			index++
		case '[':
			inClass = true
		case ']':
			inClass = false
		case '\n':
			return -1
		case '/':
			if !inClass {
				return index
			}
		}
	}
	return -1
}

func isSpace(char byte) bool {
	return char == ' ' || char == '\t' || char == '\r' || char == '\n'
}

func isIdentifier(entry string) bool {
	if entry == "" {
		return false
	}
	for index, char := range entry {
		letter := char == '_' || char == '$' || (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z')
		digit := char >= '0' && char <= '9'
		if !letter && !(digit && index > 0) {
			return false
		}
	}
	return true
}

func firstLine(text string) string {
	if newline := strings.IndexByte(text, '\n'); newline >= 0 {
		return strings.TrimSpace(text[:newline])
	}
	return strings.TrimSpace(text)
}

// Diff reports the names only TypeScript declares (missing from the Go table) and the names only
// Go declares (extra), each sorted, so a guard can print exactly what drifted.
func Diff(goNames, tsNames []string) (missing, extra []string) {
	inGo := map[string]bool{}
	for _, name := range goNames {
		inGo[name] = true
	}
	inTS := map[string]bool{}
	for _, name := range tsNames {
		inTS[name] = true
	}
	for _, name := range tsNames {
		if !inGo[name] {
			missing = append(missing, name)
		}
	}
	for _, name := range goNames {
		if !inTS[name] {
			extra = append(extra, name)
		}
	}
	sort.Strings(missing)
	sort.Strings(extra)
	return missing, extra
}

// SetDiff is Diff with the counts as a message, for a table read as a set.
func SetDiff(table string, goNames, tsNames []string) error {
	missing, extra := Diff(goNames, tsNames)
	if len(missing) == 0 && len(extra) == 0 {
		return nil
	}
	var parts []string
	if len(missing) > 0 {
		parts = append(parts, "missing from Go: "+strings.Join(missing, ", "))
	}
	if len(extra) > 0 {
		parts = append(parts, "only in Go: "+strings.Join(extra, ", "))
	}
	return fmt.Errorf("%s drifted from TypeScript: %s", table, strings.Join(parts, "; "))
}

// Keys is a map's keys, sorted.
func Keys[V any](table map[string]V) []string {
	keys := make([]string, 0, len(table))
	for key := range table {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
