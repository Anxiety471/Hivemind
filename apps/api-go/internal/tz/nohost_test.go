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
// It covers the ways the reviews found the earlier versions blind: an aliased
// `time` import, a dot-import, a zone-reading method chained on time.Now() or a
// time.Unix* result, the same method on a variable holding one of those (which
// carries time.Local until converted), a host path assembled by concatenating
// literals, and every path Go's zone search uses.
//
// internal/tz/genzones is exempt: it is the generator, not the gateway, and it
// instructs the C compiler where zic's defaults point.
func TestNoHostZoneinfoFallback(t *testing.T) {
	root := filepath.Join("..", "..")
	const self = "nohost_test.go"
	// zoneReading are the time.Time methods that read the value's location.
	// time.Now() and time.Unix* carry time.Local, so calling one of these on
	// them (without .UTC()/.In(...) in between) reads the host's zone; .Local()
	// itself converts to it.
	zoneReading := map[string]bool{
		"Local": true, "Location": true, "Format": true, "AppendFormat": true,
		"String": true, "Zone": true, "Date": true, "Clock": true,
		"Weekday": true, "Year": true, "Month": true, "Day": true, "Hour": true,
		"Minute": true, "Second": true, "Nanosecond": true, "ISOWeek": true,
		"GobEncode": true, "MarshalBinary": true,
	}
	forbidden := []string{
		"ZONEINFO", "TZDIR",
		"/usr/share/zoneinfo", "/usr/lib/zoneinfo", "/usr/share/lib/zoneinfo",
		"/etc/zoneinfo", "/usr/lib/locale/TZ",
	}
	localTaggedCall := func(expr ast.Expr, timeNames map[string]bool) bool {
		call, ok := expr.(*ast.CallExpr)
		if !ok {
			return false
		}
		selector, ok := call.Fun.(*ast.SelectorExpr)
		if !ok {
			return false
		}
		ident, ok := selector.X.(*ast.Ident)
		if !ok || !timeNames[ident.Name] {
			return false
		}
		switch selector.Sel.Name {
		case "Now", "Unix", "UnixMilli", "UnixMicro", "UnixNano":
			return true
		}
		return false
	}
	// stringFragments flattens a concatenation of string literals, so a path
	// split across literals is checked as the path it builds.
	var stringFragments func(ast.Expr) ([]string, bool)
	stringFragments = func(expr ast.Expr) ([]string, bool) {
		switch typed := expr.(type) {
		case *ast.BasicLit:
			if typed.Kind != token.STRING {
				return nil, false
			}
			value, err := strconv.Unquote(typed.Value)
			if err != nil {
				return nil, false
			}
			return []string{value}, true
		case *ast.BinaryExpr:
			if typed.Op != token.ADD {
				return nil, false
			}
			left, ok := stringFragments(typed.X)
			if !ok {
				return nil, false
			}
			right, ok := stringFragments(typed.Y)
			if !ok {
				return nil, false
			}
			return append(left, right...), true
		}
		return nil, false
	}
	type violation struct {
		file   string
		line   int
		reason string
	}
	var violations []violation

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
		add := func(node ast.Node, reason string) {
			position := fset.Position(node.Pos())
			violations = append(violations, violation{file: position.Filename, line: position.Line, reason: reason})
		}
		inTZ := strings.Contains(filepath.ToSlash(path), "/internal/tz/")
		// This package's tests name the forbidden sources to prove they are
		// ignored (a ZONEINFO fixture, host paths); the selectors, imports and
		// time-value rules stay in force for them too.
		literalExempt := inTZ && strings.HasSuffix(path, "_test.go")
		// Tests may format a clock for a message; production code may not.
		testFile := strings.HasSuffix(path, "_test.go")

		timeNames := map[string]bool{}
		for _, spec := range file.Imports {
			imported, err := strconv.Unquote(spec.Path.Value)
			if err != nil {
				return err
			}
			if imported == "time/tzdata" {
				add(spec, "imports time/tzdata; the embedded release in internal/tz is the only zone data allowed")
			}
			if imported != "time" {
				continue
			}
			if spec.Name == nil {
				timeNames["time"] = true
				continue
			}
			if spec.Name.Name == "." || spec.Name.Name == "_" {
				add(spec, "imports time as "+spec.Name.Name+", which hides where a zone source is read")
				continue
			}
			timeNames[spec.Name.Name] = true
		}

		// Variables holding a Local-tagged time.Time, so formatting one later is
		// caught even though the call is not on the same line.
		localTagged := map[string]bool{}
		mark := func(name string, value ast.Expr) {
			if localTaggedCall(value, timeNames) {
				localTagged[name] = true
			} else {
				delete(localTagged, name)
			}
		}
		ast.Inspect(file, func(node ast.Node) bool {
			switch typed := node.(type) {
			case *ast.AssignStmt:
				if len(typed.Lhs) != len(typed.Rhs) {
					return true
				}
				for index, rhs := range typed.Rhs {
					if ident, ok := typed.Lhs[index].(*ast.Ident); ok {
						mark(ident.Name, rhs)
					}
				}
			case *ast.ValueSpec:
				for index, value := range typed.Values {
					if index < len(typed.Names) {
						mark(typed.Names[index].Name, value)
					}
				}
			}
			return true
		})
		isLocalValue := func(expr ast.Expr) bool {
			switch typed := expr.(type) {
			case *ast.Ident:
				return localTagged[typed.Name]
			case *ast.CallExpr:
				return localTaggedCall(typed, timeNames)
			}
			return false
		}

		ast.Inspect(file, func(node ast.Node) bool {
			switch typed := node.(type) {
			case *ast.SelectorExpr:
				if ident, ok := typed.X.(*ast.Ident); ok && timeNames[ident.Name] {
					switch typed.Sel.Name {
					case "LoadLocation":
						add(typed, "calls time.LoadLocation, which reads ZONEINFO then the host's zoneinfo; use tz.Load or wallclock.ZoneOrUTC")
					case "Local":
						add(typed, "reads time.Local, which is the host's zone; use tz.Local or wallclock.ZoneOrUTC")
					}
				}
				if !testFile && isLocalValue(typed.X) && zoneReading[typed.Sel.Name] {
					add(typed, "reads the location of a time.Now()/time.Unix* value via ."+typed.Sel.Name+", which is the host's zone; call .UTC() or use tz.Local")
				}
			case *ast.BinaryExpr:
				if literalExempt {
					return true
				}
				fragments, ok := stringFragments(typed)
				if !ok || len(fragments) < 2 {
					return true
				}
				value := strings.Join(fragments, "")
				for _, needle := range forbidden {
					if strings.Contains(value, needle) {
						add(typed, "names the host zone source "+needle+" in a concatenation; zone rules come from internal/tz only")
					}
				}
				if strings.Contains(value, "/etc/localtime") && !inTZ {
					add(typed, "reads /etc/localtime outside internal/tz; V8's local zone is resolved by tz.Local")
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
						add(typed, "names the host zone source "+needle+"; zone rules come from internal/tz only")
					}
				}
				if strings.Contains(value, "/etc/localtime") && !inTZ {
					add(typed, "reads /etc/localtime outside internal/tz; V8's local zone is resolved by tz.Local")
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
