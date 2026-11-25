package tz

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// TestNoHostZoneinfoFallback is the audit that keeps the fix from regressing:
// the gateway binary must read zone rules only from this package's embedded
// release (or, for an explicitly configured TZ path, from the file the operator
// named). Go's loaders and the paths and methods that reach the host's zones
// are named here so the check fails loudly if any package reintroduces one.
//
// It covers the ways the review found the earlier version blind: an aliased
// `time` import, a dot-import, a zone-reading method chained on time.Now()
// (which is Local-tagged), and every path Go's zone search uses.
//
// internal/tz/genzones is exempt: it is the generator, not the gateway, and it
// instructs the C compiler where zic's defaults point.
func TestNoHostZoneinfoFallback(t *testing.T) {
	root := filepath.Join("..", "..")
	const self = "nohost_test.go"
	// zoneReading are the time.Time methods that read the value's location.
	// time.Now() carries time.Local, so calling one of these on it (without
	// .UTC()/.In(...) in between) reads the host's zone.
	zoneReading := map[string]bool{
		"Location": true, "Format": true, "AppendFormat": true, "String": true,
		"Zone": true, "Date": true, "Clock": true, "Weekday": true,
		"Year": true, "Month": true, "Day": true, "Hour": true, "Minute": true,
		"Second": true, "Nanosecond": true, "ISOWeek": true,
		"GobEncode": true, "MarshalBinary": true,
	}
	forbidden := []string{
		"ZONEINFO", "TZDIR",
		"/usr/share/zoneinfo", "/usr/lib/zoneinfo", "/usr/share/lib/zoneinfo",
		"/etc/zoneinfo", "/usr/lib/locale/TZ",
	}
	type violation struct {
		file   string
		line   int
		reason string
	}
	var violations []violation
	add := func(fset *token.FileSet, node ast.Node, reason string) {
		position := fset.Position(node.Pos())
		violations = append(violations, violation{file: position.Filename, line: position.Line, reason: reason})
	}

	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			switch entry.Name() {
			case "testdata", "genzones", "node_modules":
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || entry.Name() == self {
			return nil
		}
		fset := token.NewFileSet()
		file, err := parser.ParseFile(fset, path, nil, 0)
		if err != nil {
			return err
		}
		inTZ := strings.Contains(filepath.ToSlash(path), "/internal/tz/")
		// This package's tests name the forbidden sources to prove they are
		// ignored (a ZONEINFO fixture, host paths); the selectors, imports and
		// time.Now() rules stay in force for them too.
		literalExempt := inTZ && strings.HasSuffix(path, "_test.go")
		// Tests may format a clock for a message; production code may not.
		nowExempt := strings.HasSuffix(path, "_test.go")

		timeNames := map[string]bool{}
		for _, spec := range file.Imports {
			imported, err := strconv.Unquote(spec.Path.Value)
			if err != nil {
				return err
			}
			if imported == "time/tzdata" {
				add(fset, spec, "imports time/tzdata; the embedded release in internal/tz is the only zone data allowed")
			}
			if imported != "time" {
				continue
			}
			if spec.Name == nil {
				timeNames["time"] = true
				continue
			}
			if spec.Name.Name == "." || spec.Name.Name == "_" {
				add(fset, spec, "imports time as "+spec.Name.Name+", which hides where a zone source is read")
				continue
			}
			timeNames[spec.Name.Name] = true
		}
		isTimeNow := func(call *ast.CallExpr) bool {
			selector, ok := call.Fun.(*ast.SelectorExpr)
			if !ok || selector.Sel.Name != "Now" || len(call.Args) != 0 {
				return false
			}
			ident, ok := selector.X.(*ast.Ident)
			return ok && timeNames[ident.Name]
		}
		ast.Inspect(file, func(node ast.Node) bool {
			switch typed := node.(type) {
			case *ast.SelectorExpr:
				if ident, ok := typed.X.(*ast.Ident); ok && timeNames[ident.Name] {
					switch typed.Sel.Name {
					case "LoadLocation":
						add(fset, typed, "calls time.LoadLocation, which reads ZONEINFO then the host's zoneinfo; use tz.Load or wallclock.ZoneOrUTC")
					case "Local":
						add(fset, typed, "reads time.Local, which is the host's zone; use tz.Local or wallclock.ZoneOrUTC")
					}
				}
				if call, ok := typed.X.(*ast.CallExpr); ok && !nowExempt && isTimeNow(call) && zoneReading[typed.Sel.Name] {
					add(fset, typed, "reads the location of time.Now() via ."+typed.Sel.Name+", which is the host's zone; call .UTC() or use tz.Local")
				}
			case *ast.BasicLit:
				if typed.Kind != token.STRING || literalExempt {
					return true
				}
				value, err := strconv.Unquote(typed.Value)
				if err != nil {
					return true
				}
				for _, needle := range forbidden {
					if strings.Contains(value, needle) {
						add(fset, typed, "names the host zone source "+needle+"; zone rules come from internal/tz only")
					}
				}
				if strings.Contains(value, "/etc/localtime") && !inTZ {
					add(fset, typed, "reads /etc/localtime outside internal/tz; V8's local zone is resolved by tz.Local")
				}
			}
			return true
		})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, found := range violations {
		t.Errorf("%s:%d: %s", found.file, found.line, found.reason)
	}
}
