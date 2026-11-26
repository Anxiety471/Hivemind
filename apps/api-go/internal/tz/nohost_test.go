package tz

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"regexp"
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
// It covers the ways the reviews found earlier versions blind: an aliased
// `time` import, a dot-import, a zone-reading method chained on time.Now() or a
// time.Unix* result, the same method on a variable holding one of those (which
// carries time.Local until converted, and through aliases such as
// `m := n`), parenthesised receivers, range variables over a clock value, a
// host path assembled by concatenating literals or by filepath.Join /
// fmt.Sprintf, and every path Go's zone search uses. The tag is scoped to one
// function (a conversion in one function cannot hide a violation in another)
// and survives a reassignment inside a branch, where the conversion may not run.
//
// An idiom that cannot be evaluated precisely (a computed path assembled from
// non-constant parts) is reported unless the offending line carries a
// `//tzguard:ok <reason>` annotation.
//
// internal/tz/genzones is exempt: it is the generator, not the gateway, and it
// instructs the C compiler where zic's defaults point.
func TestNoHostZoneinfoFallback(t *testing.T) {
	root := filepath.Join("..", "..")
	const self = "nohost_test.go"
	forbidden := []string{
		"ZONEINFO", "TZDIR",
		"/usr/share/zoneinfo", "/usr/lib/zoneinfo", "/usr/share/lib/zoneinfo",
		"/etc/zoneinfo", "/usr/lib/locale/TZ",
	}
	// zoneReading are the time.Time methods that read the value's location.
	zoneReading := map[string]bool{
		"Local": true, "Location": true, "Format": true, "AppendFormat": true,
		"String": true, "Zone": true, "Date": true, "Clock": true,
		"Weekday": true, "Year": true, "Month": true, "Day": true, "Hour": true,
		"Minute": true, "Second": true, "Nanosecond": true, "ISOWeek": true,
		"GobEncode": true, "MarshalBinary": true,
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
		file, err := parser.ParseFile(fset, path, nil, parser.ParseComments)
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

		annotations := map[int]bool{}
		for _, group := range file.Comments {
			for _, comment := range group.List {
				if text := strings.TrimSpace(strings.TrimPrefix(comment.Text, "//")); strings.HasPrefix(text, "tzguard:ok ") &&
					strings.TrimSpace(strings.TrimPrefix(text, "tzguard:ok ")) != "" {
					annotations[fset.Position(comment.Pos()).Line] = true
				}
			}
		}

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

		g := &guard{
			fset: fset, add: add, annotations: annotations, timeNames: timeNames,
			zoneReading: zoneReading, forbidden: forbidden,
			inTZ: inTZ, literalExempt: literalExempt, testFile: testFile,
			scope: map[string]bool{},
		}
		// Package-level declarations are checked once; a variable initialized
		// from a clock value is inherited by every function, nothing flows the
		// other way.
		for _, decl := range file.Decls {
			gen, ok := decl.(*ast.GenDecl)
			if !ok {
				continue
			}
			g.checkNode(gen)
			if gen.Tok != token.VAR {
				continue
			}
			for _, spec := range gen.Specs {
				value, ok := spec.(*ast.ValueSpec)
				if !ok {
					continue
				}
				for index, name := range value.Names {
					if index < len(value.Values) && g.tagged(value.Values[index]) {
						g.scope[name.Name] = true
					}
				}
			}
		}
		for _, decl := range file.Decls {
			if function, ok := decl.(*ast.FuncDecl); ok {
				g.walkFunc(function.Body)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, found := range violations {
		t.Errorf("%s:%d: %s", found.file, found.line, found.reason)
	}
}

// guard carries one file's audit state. scope maps variable names to "holds a
// time.Time whose location is the host's"; it is reset per function.
type guard struct {
	fset          *token.FileSet
	add           func(ast.Node, string)
	annotations   map[int]bool
	timeNames     map[string]bool
	zoneReading   map[string]bool
	forbidden     []string
	inTZ          bool
	literalExempt bool
	testFile      bool
	scope         map[string]bool
}

// annotated reports whether the line carries `//tzguard:ok <reason>`.
func (g *guard) annotated(node ast.Node) bool {
	return g.annotations[g.fset.Position(node.Pos()).Line]
}

// conditional reports a violation that an annotation may silence: the idiom is
// suspicious but not provably a host read.
func (g *guard) conditional(node ast.Node, reason string) {
	if g.annotated(node) {
		return
	}
	g.add(node, reason)
}

// clockCall reports whether expr is time.Now() or a time.Unix* call.
func (g *guard) clockCall(expr ast.Expr) bool {
	call, ok := expr.(*ast.CallExpr)
	if !ok {
		return false
	}
	selector, ok := call.Fun.(*ast.SelectorExpr)
	if !ok {
		return false
	}
	ident, ok := selector.X.(*ast.Ident)
	if !ok || !g.timeNames[ident.Name] {
		return false
	}
	switch selector.Sel.Name {
	case "Now", "Unix", "UnixMilli", "UnixMicro", "UnixNano":
		return true
	}
	return false
}

// tagged reports whether expr evaluates to a time.Time in the process zone.
func (g *guard) tagged(expr ast.Expr) bool {
	switch typed := expr.(type) {
	case *ast.ParenExpr:
		return g.tagged(typed.X)
	case *ast.Ident:
		return g.scope[typed.Name]
	case *ast.CallExpr:
		if g.clockCall(typed) {
			return true
		}
		if selector, ok := typed.Fun.(*ast.SelectorExpr); ok {
			switch selector.Sel.Name {
			case "UTC", "In":
				// The result's location is explicit, not the host's.
				return false
			case "Local":
				return true
			}
			if g.tagged(selector.X) {
				// .Add, .Round, .Truncate, ... keep the receiver's location.
				return true
			}
		}
		for _, argument := range typed.Args {
			if g.tagged(argument) {
				return true
			}
		}
		return false
	case *ast.SelectorExpr:
		// A field of a struct: the field's location is data flow this guard
		// does not follow; treat the value as not tagged (documented residual).
		return false
	}
	return false
}

// containsTagged reports whether any part of expr is a process-zone value.
func (g *guard) containsTagged(expr ast.Expr) bool {
	found := false
	ast.Inspect(expr, func(node ast.Node) bool {
		if found {
			return false
		}
		if expr, ok := node.(ast.Expr); ok && g.tagged(expr) {
			found = true
			return false
		}
		return true
	})
	return found
}

// constantString evaluates a literal, a concatenation of literals and a
// filepath.Join/path.Join of those. It never guesses: non-constant parts fail.
func constantString(expr ast.Expr) (string, bool) {
	switch typed := expr.(type) {
	case *ast.ParenExpr:
		return constantString(typed.X)
	case *ast.BasicLit:
		if typed.Kind != token.STRING {
			return "", false
		}
		value, err := strconv.Unquote(typed.Value)
		if err != nil {
			return "", false
		}
		return value, true
	case *ast.BinaryExpr:
		if typed.Op != token.ADD {
			return "", false
		}
		left, ok := constantString(typed.X)
		if !ok {
			return "", false
		}
		right, ok := constantString(typed.Y)
		if !ok {
			return "", false
		}
		return left + right, true
	case *ast.CallExpr:
		selector, ok := typed.Fun.(*ast.SelectorExpr)
		if !ok || selector.Sel.Name != "Join" {
			return "", false
		}
		ident, ok := selector.X.(*ast.Ident)
		if !ok || (ident.Name != "filepath" && ident.Name != "path") {
			return "", false
		}
		parts := make([]string, 0, len(typed.Args))
		for _, argument := range typed.Args {
			part, ok := constantString(argument)
			if !ok {
				return "", false
			}
			parts = append(parts, part)
		}
		return filepath.Join(parts...), true
	}
	return "", false
}

var sprintfVerb = regexp.MustCompile(`%[-+ #0-9.]*[a-zA-Z%]`)

// sprintfSample renders a format string with constant arguments; non-constant
// verbs become "?". It is an approximation used only to look for path needles.
func sprintfSample(call *ast.CallExpr) (string, bool) {
	format, ok := constantString(call.Args[0])
	if !ok {
		return "", false
	}
	values := make([]string, 0, len(call.Args)-1)
	for _, argument := range call.Args[1:] {
		if value, ok := constantString(argument); ok {
			values = append(values, value)
			continue
		}
		values = append(values, "?")
	}
	next := 0
	sample := sprintfVerb.ReplaceAllStringFunc(format, func(verb string) string {
		if strings.HasSuffix(verb, "%") {
			return "%"
		}
		if next < len(values) {
			next++
			return values[next-1]
		}
		return ""
	})
	return sample, true
}

// checkExpr reports violations anywhere in expr.
func (g *guard) checkExpr(expr ast.Expr) {
	ast.Inspect(expr, func(node ast.Node) bool {
		switch typed := node.(type) {
		case *ast.FuncLit:
			saved := cloneScope(g.scope)
			g.checkNode(typed.Type)
			g.walkBlock(typed.Body, true)
			g.scope = saved
			return false
		case *ast.SelectorExpr:
			if ident, ok := typed.X.(*ast.Ident); ok && g.timeNames[ident.Name] {
				switch typed.Sel.Name {
				case "LoadLocation":
					g.add(typed, "calls time.LoadLocation, which reads ZONEINFO then the host's zoneinfo; use tz.Load or wallclock.ZoneOrUTC")
				case "Local":
					g.add(typed, "reads time.Local, which is the host's zone; use tz.Local or wallclock.ZoneOrUTC")
				}
			}
			if !g.testFile && g.zoneReading[typed.Sel.Name] && g.tagged(typed.X) {
				g.add(typed, "reads the location of a time.Now()/time.Unix* value via ."+typed.Sel.Name+", which is the host's zone; call .UTC() or use tz.Local")
			}
		case *ast.CallExpr:
			g.checkComputedPath(typed)
		case *ast.BinaryExpr:
			if g.literalExempt {
				return true
			}
			fragments, ok := stringFragments(typed)
			if !ok || len(fragments) < 2 {
				return true
			}
			g.checkPathText(typed, strings.Join(fragments, ""), "concatenation")
		case *ast.BasicLit:
			if typed.Kind != token.STRING || g.literalExempt {
				return true
			}
			value, err := strconv.Unquote(typed.Value)
			if err != nil {
				return true
			}
			g.checkPathText(typed, value, "literal")
		}
		return true
	})
}

// checkPathText reports a forbidden host-zone name in text.
func (g *guard) checkPathText(node ast.Node, value, kind string) {
	for _, needle := range g.forbidden {
		if strings.Contains(value, needle) {
			g.add(node, "names the host zone source "+needle+" in a "+kind+"; zone rules come from internal/tz only")
		}
	}
	if strings.Contains(value, "/etc/localtime") && !g.inTZ {
		g.add(node, "reads /etc/localtime outside internal/tz; V8's local zone is resolved by tz.Local")
	}
}

// checkComputedPath evaluates filepath.Join and fmt.Sprintf calls. A constant
// result is checked exactly; a partly constant one is reported unless the line
// is annotated, because the guard cannot prove where it points.
func (g *guard) checkComputedPath(call *ast.CallExpr) {
	if g.literalExempt {
		return
	}
	selector, ok := call.Fun.(*ast.SelectorExpr)
	if !ok {
		return
	}
	ident, ok := selector.X.(*ast.Ident)
	if !ok {
		return
	}
	switch {
	case selector.Sel.Name == "Join" && (ident.Name == "filepath" || ident.Name == "path"):
		if value, ok := constantString(call); ok {
			g.checkPathText(call, value, "filepath.Join")
			return
		}
		g.suspiciousJoin(call, ident.Name+"."+selector.Sel.Name)
	case selector.Sel.Name == "Sprintf" && ident.Name == "fmt":
		if sample, ok := sprintfSample(call); ok {
			g.checkPathText(call, sample, "fmt.Sprintf")
		}
		for _, argument := range call.Args {
			if value, ok := constantString(argument); ok {
				for _, needle := range g.forbidden {
					if strings.Contains(value, needle) {
						g.conditional(call, "fmt.Sprintf assembles a path from "+needle+" and non-constant parts; add //tzguard:ok <reason> if this is not a host zone source")
					}
				}
				if strings.Contains(value, "zoneinfo") && !strings.Contains(value, string(filepath.Separator)+"zoneinfo"+string(filepath.Separator)) {
					g.conditional(call, "fmt.Sprintf builds a path from the literal "+strconv.Quote(value)+" and non-constant parts; add //tzguard:ok <reason> if this is not the host zone tree")
				}
			}
		}
	}
}

// suspiciousJoin reports a filepath.Join whose constant parts look like a zone
// path but which the guard cannot evaluate fully.
func (g *guard) suspiciousJoin(call *ast.CallExpr, kind string) {
	for _, argument := range call.Args {
		value, ok := constantString(argument)
		if !ok {
			continue
		}
		for _, needle := range g.forbidden {
			if strings.Contains(value, needle) {
				g.conditional(call, kind+" assembles "+needle+" with non-constant parts; add //tzguard:ok <reason> if this is not a host zone source")
			}
		}
		if value == "zoneinfo" || strings.HasSuffix(value, "/zoneinfo") || strings.HasPrefix(value, "/usr") || strings.HasPrefix(value, "/etc") {
			g.conditional(call, kind+" builds a path from "+strconv.Quote(value)+" and non-constant parts; add //tzguard:ok <reason> if this is not the host zone tree")
		}
	}
}

// stringFragments flattens a concatenation of string literals, so a path split
// across literals is checked as the path it builds.
func stringFragments(expr ast.Expr) ([]string, bool) {
	switch typed := expr.(type) {
	case *ast.ParenExpr:
		return stringFragments(typed.X)
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

func cloneScope(scope map[string]bool) map[string]bool {
	copied := make(map[string]bool, len(scope))
	for name, tagged := range scope {
		copied[name] = tagged
	}
	return copied
}

// walkFunc analyzes one function with its own tag scope.
func (g *guard) walkFunc(body *ast.BlockStmt) {
	if body == nil {
		return
	}
	saved := g.scope
	g.scope = cloneScope(saved)
	g.walkBlock(body, false)
	g.scope = saved
}

// walkBlock analyzes a nested block: variables declared inside do not escape,
// and a tag cleared inside (where the assignment may not run) is restored, so a
// later use outside still fails.
func (g *guard) walkBlock(block *ast.BlockStmt, conditional bool) {
	if block == nil {
		return
	}
	saved := cloneScope(g.scope)
	for _, statement := range block.List {
		g.walkStmt(statement, conditional)
	}
	g.scope = saved
}

// walkStmt walks one statement, tracking which identifiers hold a process-zone
// time.
func (g *guard) walkStmt(statement ast.Stmt, conditional bool) {
	switch typed := statement.(type) {
	case *ast.AssignStmt:
		for _, expression := range typed.Rhs {
			g.checkExpr(expression)
		}
		for index, left := range typed.Lhs {
			ident, ok := left.(*ast.Ident)
			if !ok {
				g.checkExpr(left)
				continue
			}
			if ident.Name == "_" {
				continue
			}
			var value ast.Expr
			if len(typed.Lhs) == len(typed.Rhs) {
				value = typed.Rhs[index]
			}
			g.assign(ident.Name, value, conditional)
		}
	case *ast.DeclStmt:
		gen, ok := typed.Decl.(*ast.GenDecl)
		if !ok {
			return
		}
		for _, spec := range gen.Specs {
			value, ok := spec.(*ast.ValueSpec)
			if !ok {
				continue
			}
			for _, expression := range value.Values {
				g.checkExpr(expression)
			}
			for index, name := range value.Names {
				var initializer ast.Expr
				if index < len(value.Values) {
					initializer = value.Values[index]
				}
				g.assign(name.Name, initializer, conditional)
			}
		}
	case *ast.ExprStmt:
		g.checkExpr(typed.X)
	case *ast.ReturnStmt:
		for _, expression := range typed.Results {
			g.checkExpr(expression)
		}
	case *ast.IfStmt:
		if typed.Init != nil {
			g.walkStmt(typed.Init, conditional)
		}
		g.checkExpr(typed.Cond)
		g.walkBlock(typed.Body, true)
		if typed.Else != nil {
			g.walkStmt(typed.Else, true)
		}
	case *ast.ForStmt:
		if typed.Init != nil {
			g.walkStmt(typed.Init, conditional)
		}
		if typed.Cond != nil {
			g.checkExpr(typed.Cond)
		}
		if typed.Post != nil {
			g.walkStmt(typed.Post, true)
		}
		g.walkBlock(typed.Body, true)
	case *ast.RangeStmt:
		g.checkExpr(typed.X)
		saved := cloneScope(g.scope)
		holdsClock := g.containsTagged(typed.X)
		for _, expression := range []ast.Expr{typed.Key, typed.Value} {
			if ident, ok := expression.(*ast.Ident); ok && ident.Name != "_" && holdsClock {
				g.scope[ident.Name] = true
			}
		}
		g.walkBlock(typed.Body, true)
		g.scope = saved
	case *ast.SwitchStmt:
		if typed.Init != nil {
			g.walkStmt(typed.Init, conditional)
		}
		if typed.Tag != nil {
			g.checkExpr(typed.Tag)
		}
		saved := cloneScope(g.scope)
		for _, clause := range typed.Body.List {
			g.walkBlock(&ast.BlockStmt{List: clause.(*ast.CaseClause).Body}, true)
		}
		g.scope = saved
	case *ast.TypeSwitchStmt:
		if typed.Init != nil {
			g.walkStmt(typed.Init, conditional)
		}
		g.walkStmt(typed.Assign, conditional)
		saved := cloneScope(g.scope)
		for _, clause := range typed.Body.List {
			g.walkBlock(&ast.BlockStmt{List: clause.(*ast.CaseClause).Body}, true)
		}
		g.scope = saved
	case *ast.SelectStmt:
		saved := cloneScope(g.scope)
		for _, clause := range typed.Body.List {
			g.walkBlock(&ast.BlockStmt{List: clause.(*ast.CommClause).Body}, true)
		}
		g.scope = saved
	case *ast.BlockStmt:
		g.walkBlock(typed, conditional)
	case *ast.LabeledStmt:
		g.walkStmt(typed.Stmt, conditional)
	case *ast.GoStmt:
		g.checkExpr(typed.Call)
	case *ast.DeferStmt:
		g.checkExpr(typed.Call)
	case *ast.IncDecStmt:
		g.checkExpr(typed.X)
	case *ast.SendStmt:
		g.checkExpr(typed.Chan)
		g.checkExpr(typed.Value)
	}
}

// assign updates the tag for a target variable. A tagged value tags it; a
// location-changing conversion clears it only on an unconditional assignment,
// because inside a branch the conversion may not run and a later use would
// still read the host zone.
func (g *guard) assign(name string, value ast.Expr, conditional bool) {
	if value != nil && g.tagged(value) {
		g.scope[name] = true
		return
	}
	if conditional && g.scope[name] {
		return
	}
	delete(g.scope, name)
}

// checkNode runs the expression checks over a node that is not a statement
// (package-level declarations).
func (g *guard) checkNode(node ast.Node) {
	ast.Inspect(node, func(child ast.Node) bool {
		if expression, ok := child.(ast.Expr); ok {
			g.checkExpr(expression)
			return false
		}
		return true
	})
}
