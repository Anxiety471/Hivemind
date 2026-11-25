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
// release. Go's loaders and docs are named here so the check fails loudly if
// any package reintroduces one.
//
// internal/tz/genzones is exempt: it is the generator, not the gateway, and it
// instructs the C compiler where zic's defaults point.
func TestNoHostZoneinfoFallback(t *testing.T) {
	root := filepath.Join("..", "..")
	const self = "nohost_test.go"
	forbidden := []string{"ZONEINFO", "TZDIR", "/usr/share/zoneinfo"}
	type location struct {
		file   string
		line   int
		reason string
	}
	var violations []location
	add := func(fset *token.FileSet, node ast.Node, reason string) {
		position := fset.Position(node.Pos())
		violations = append(violations, location{file: position.Filename, line: position.Line, reason: reason})
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
		// ignored (a ZONEINFO fixture, a host symlink target); the selectors and
		// imports stay forbidden for them too.
		literalExempt := inTZ && strings.HasSuffix(path, "_test.go")
		for _, spec := range file.Imports {
			imported, err := strconv.Unquote(spec.Path.Value)
			if err != nil {
				return err
			}
			if imported == "time/tzdata" {
				add(fset, spec, "imports time/tzdata; the embedded release in internal/tz is the only zone data allowed")
			}
		}
		ast.Inspect(file, func(node ast.Node) bool {
			switch typed := node.(type) {
			case *ast.SelectorExpr:
				ident, ok := typed.X.(*ast.Ident)
				if !ok || ident.Name != "time" {
					return true
				}
				switch typed.Sel.Name {
				case "LoadLocation":
					add(fset, typed, "calls time.LoadLocation, which reads ZONEINFO then the host's zoneinfo; use tz.Load or wallclock.ZoneOrUTC")
				case "Local":
					add(fset, typed, "reads time.Local, which is the host's zone; use tz.Local or wallclock.ZoneOrUTC")
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
	for _, violation := range violations {
		t.Errorf("%s:%d: %s", violation.file, violation.line, violation.reason)
	}
}
