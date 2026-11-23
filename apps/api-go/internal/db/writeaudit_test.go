package db

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// TestWriteStatementsUseTheDataBoundary walks every non-test Go file under
// internal/ and cmd/ and audits each INSERT or UPDATE that binds values:
//
//   - A placeholder in a payload position (INSERT VALUES/SELECT list, UPDATE
//     SET clause, including ON CONFLICT DO UPDATE) must be covered by
//     db.Data/db.Text/db.JSON/db.JSONText.
//   - A placeholder in a filter position (WHERE/HAVING, UPDATE ... FROM, the
//     USING/conflict predicate) must not be wrapped: Prisma leaves filters to
//     the wire rule, so a NUL there has to reach PostgreSQL unchanged.
//   - Every argument must be accounted for; an extra or missing argument, an
//     argument list the analyzer cannot see through, or a statement whose SQL
//     cannot be resolved is a failure unless the call carries an explicit
//     `//writeaudit:dynamic <reason>` comment. Exemptions are printed, so the
//     list stays visible to review.
//
// DELETE and reads are filter-only, but a wrapped argument on a DELETE is still
// a violation because it would sanitize a filter.
func TestWriteStatementsUseTheDataBoundary(t *testing.T) {
	root := filepath.Join("..", "..")
	var files []string
	for _, directory := range []string{"internal", "cmd"} {
		err := filepath.Walk(filepath.Join(root, directory), func(path string, info os.FileInfo, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if info.IsDir() {
				if info.Name() == "testdata" {
					return filepath.SkipDir
				}
				return nil
			}
			if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
				return nil
			}
			files = append(files, path)
			return nil
		})
		if err != nil {
			t.Fatalf("walk %s: %v", directory, err)
		}
	}
	violations, exemptions := auditWriteFiles(t, files)
	for _, exemption := range exemptions {
		t.Logf("writeaudit exemption: %s", exemption)
	}
	if len(violations) > 0 {
		t.Fatalf("write boundary violations:\n%s", strings.Join(violations, "\n"))
	}
}

// TestWriteAuditRejectsBypasses runs the guard over the reviewer's bypass
// fixtures, so each fail-closed rule is proven rather than assumed. The
// fixtures live under testdata and are parsed only, never compiled.
func TestWriteAuditRejectsBypasses(t *testing.T) {
	for _, test := range []struct {
		file string
		want []string
	}{
		{"bypass_mutated_args.go", []string{"argument slice args is mutated after it is built"}},
		{"bypass_copyfrom.go", []string{"CopyFrom bypasses the placeholder audit"}},
		{"bypass_sendbatch.go", []string{"SendBatch bypasses the placeholder audit", "Queue bypasses the placeholder audit"}},
		{"bypass_method_value.go", []string{"Exec is used as a method value"}},
		{"bypass_select_function.go", []string{"SELECT calls unpure function ADD_JOB"}},
		{"bypass_dynamic_select_function.go", []string{"SQL contains an unresolved fragment"}},
		{"bypass_dynamic_where.go", []string{"SQL contains an unresolved fragment"}},
		{"allow_pure_select.go", nil},
	} {
		path := filepath.Join("testdata", "writeaudit", test.file)
		violations, _ := auditWriteFiles(t, []string{path})
		joined := strings.Join(violations, "\n")
		if len(test.want) == 0 {
			if len(violations) != 0 {
				t.Errorf("%s should pass the audit; got %v", test.file, violations)
			}
			continue
		}
		if len(violations) == 0 {
			t.Fatalf("%s passed the audit; want %v", test.file, test.want)
		}
		for _, want := range test.want {
			if !strings.Contains(joined, want) {
				t.Errorf("%s: violations %q do not contain %q", test.file, violations, want)
			}
		}
	}
}

// auditWriteFiles audits the given Go files and returns the violations and the
// accepted exemptions, labelled with the path as given.
func auditWriteFiles(t *testing.T, paths []string) ([]string, []string) {
	t.Helper()
	var violations []string
	var exemptions []string
	report := func(where, message string) {
		violations = append(violations, where+" "+message)
	}
	for _, path := range paths {
		fset := token.NewFileSet()
		file, err := parser.ParseFile(fset, path, nil, parser.ParseComments)
		if err != nil {
			t.Fatalf("parse %s: %v", path, err)
		}
		analysis := newFileAnalysis(file)
		at := func(node ast.Node) string {
			position := fset.Position(node.Pos())
			return path + ":" + strconv.Itoa(position.Line)
		}
		exemptOr := func(where string, node ast.Node, message string) {
			if reason, ok := exemptionAt(file, fset, node.Pos()); ok {
				exemptions = append(exemptions, where+" "+reason)
				return
			}
			report(where, message+"; add //writeaudit:dynamic <reason>")
		}
		// A write API that does not take a $n argument list defeats placeholder
		// mapping, and a method value takes Exec/Query/QueryRow out of reach.
		calledSelectors := map[*ast.SelectorExpr]bool{}
		assignedSelectors := map[*ast.SelectorExpr]bool{}
		ast.Inspect(file, func(node ast.Node) bool {
			switch typed := node.(type) {
			case *ast.CallExpr:
				if selector, ok := typed.Fun.(*ast.SelectorExpr); ok {
					calledSelectors[selector] = true
				}
			case *ast.AssignStmt:
				for _, left := range typed.Lhs {
					if selector, ok := left.(*ast.SelectorExpr); ok {
						assignedSelectors[selector] = true
					}
				}
			}
			return true
		})
		ast.Inspect(file, func(node ast.Node) bool {
			selector, ok := node.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			switch selector.Sel.Name {
			case "CopyFrom", "SendBatch", "Queue", "Exec", "Query", "QueryRow":
			default:
				return true
			}
			if !calledSelectors[selector] && !assignedSelectors[selector] {
				exemptOr(at(selector), selector, selector.Sel.Name+" is used as a method value; the audit cannot follow it")
			}
			return true
		})
		ast.Inspect(file, func(node ast.Node) bool {
			call, ok := node.(*ast.CallExpr)
			if !ok {
				return true
			}
			selector, ok := call.Fun.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			where := at(call)
			switch selector.Sel.Name {
			case "CopyFrom":
				exemptOr(where, call, "CopyFrom bypasses the placeholder audit")
				return true
			case "SendBatch":
				exemptOr(where, call, "SendBatch bypasses the placeholder audit")
				return true
			case "Queue":
				exemptOr(where, call, "Queue bypasses the placeholder audit")
				return true
			case "Exec", "Query", "QueryRow":
			default:
				return true
			}
			// A call without a SQL argument cannot bind a boundary value.
			if len(call.Args) < 2 {
				return true
			}
			locals := analysis.localsAt(call.Pos())
			variants := analysis.sqlVariants(call.Args[1], locals)
			if len(variants) == 0 {
				if analysis.provablyRead(call.Args[1], locals) {
					return true
				}
				exemptOr(where, call, "SQL is not statically resolvable")
				return true
			}
			for _, sql := range variants {
				if strings.Contains(sql, unresolvedFragment) {
					exemptOr(where, call, "SQL contains an unresolved fragment")
					return true
				}
			}
			// A resolved statement with no bound values cannot cross the boundary.
			if len(call.Args) < 3 {
				return true
			}
			for _, sql := range variants {
				kind, placeholders, problem := classifyStatement(sql)
				if problem != "" {
					exemptOr(where, call, problem)
					return true
				}
				if kind == "read" {
					if calls := unpureSelectCalls(sql); len(calls) > 0 {
						exemptOr(where, call, "SELECT calls unpure function "+strings.Join(calls, ", "))
					}
					continue
				}
				if kind == "delete" {
					slots, resolved := analysis.argumentSlots(call)
					if !resolved {
						exemptOr(where, call, "DELETE argument list is not statically auditable")
						continue
					}
					for index, slot := range slots[1:] {
						if slot.wrapped {
							report(where, "DELETE $"+strconv.Itoa(index)+" is wrapped; filters must stay unwrapped")
							return true
						}
					}
					continue
				}
				if name, mutated := analysis.mutatedArgumentSlice(call); mutated {
					exemptOr(where, call, "argument slice "+name+" is mutated after it is built")
					return true
				}
				slots, resolved := analysis.argumentSlots(call)
				if !resolved {
					exemptOr(where, call, "argument list is not statically auditable")
					return true
				}
				if len(slots) != len(placeholders)+1 {
					report(where, "binds "+strconv.Itoa(len(slots)-1)+" arguments for "+strconv.Itoa(len(placeholders))+" placeholders")
					return true
				}
				for index := 1; index <= len(placeholders); index++ {
					slot := slots[index]
					data := placeholders[index].data
					filter := placeholders[index].filter
					if data && !slot.wrapped {
						report(where, " $"+strconv.Itoa(index)+" is a payload but is not wrapped in db.Data/db.Text/db.JSON/db.JSONText")
						return true
					}
					if filter && slot.wrapped {
						report(where, " $"+strconv.Itoa(index)+" is a filter but is wrapped")
						return true
					}
					if data && filter {
						report(where, " $"+strconv.Itoa(index)+" is used as both payload and filter")
						return true
					}
				}
			}
			return true
		})
	}
	return violations, exemptions
}

// exemption reports the reason on a //writeaudit:dynamic comment attached to the
// call's statement, or to the call line itself.
func exemption(file *ast.File, fset *token.FileSet, call *ast.CallExpr) (string, bool) {
	return exemptionAt(file, fset, call.Pos())
}

// exemptionAt is exemption for any node position, so a method value can be
// exempted on its own line.
func exemptionAt(file *ast.File, fset *token.FileSet, position token.Pos) (string, bool) {
	line := fset.Position(position).Line
	for _, group := range file.Comments {
		start := fset.Position(group.Pos()).Line
		end := fset.Position(group.End()).Line
		if start > line || end < line-1 {
			continue
		}
		for _, comment := range group.List {
			if index := strings.Index(comment.Text, "writeaudit:dynamic"); index >= 0 {
				reason := strings.TrimSpace(comment.Text[index+len("writeaudit:dynamic"):])
				if reason == "" {
					reason = "(no reason)"
				}
				return reason, true
			}
		}
	}
	return "", false
}

type fileAnalysis struct {
	file      *ast.File
	constants map[string][]string
	maps      map[string][]string
	scopes    map[ast.Node]map[string][]string
}

func newFileAnalysis(file *ast.File) *fileAnalysis {
	analysis := &fileAnalysis{file: file, constants: map[string][]string{}, maps: map[string][]string{}, scopes: map[ast.Node]map[string][]string{}}
	for _, declaration := range file.Decls {
		generic, ok := declaration.(*ast.GenDecl)
		if !ok || (generic.Tok != token.CONST && generic.Tok != token.VAR) {
			continue
		}
		for _, spec := range generic.Specs {
			value, ok := spec.(*ast.ValueSpec)
			if !ok {
				continue
			}
			for index, name := range value.Names {
				if index >= len(value.Values) {
					continue
				}
				expression := value.Values[index]
				analysis.constants[name.Name] = analysis.stringVariants(expression, nil)
				if literal, ok := expression.(*ast.CompositeLit); ok {
					var values []string
					for _, element := range literal.Elts {
						if pair, ok := element.(*ast.KeyValueExpr); ok {
							values = append(values, analysis.stringVariants(pair.Value, nil)...)
						}
					}
					if len(values) > 0 {
						analysis.maps[name.Name] = capVariants(values)
					}
				}
			}
		}
	}
	return analysis
}

// enclosingFunctions lists the function scopes around a position, innermost
// first, so a closure can read its caller's `query` while another function's
// same-named variable stays out of reach.
func (analysis *fileAnalysis) enclosingFunctions(position token.Pos) []ast.Node {
	var nodes []ast.Node
	ast.Inspect(analysis.file, func(node ast.Node) bool {
		if node == nil {
			return false
		}
		switch node.(type) {
		case *ast.FuncDecl, *ast.FuncLit:
			if node.Pos() <= position && position <= node.End() {
				nodes = append(nodes, node)
			}
		}
		return true
	})
	return nodes
}

// localsAt returns the string locals of each enclosing function, innermost first.
func (analysis *fileAnalysis) localsAt(position token.Pos) []map[string][]string {
	nodes := analysis.enclosingFunctions(position)
	scopes := make([]map[string][]string, 0, len(nodes))
	for index := len(nodes) - 1; index >= 0; index-- {
		scopes = append(scopes, analysis.localsFor(nodes[index]))
	}
	return scopes
}

func (analysis *fileAnalysis) localsFor(scope ast.Node) map[string][]string {
	if cached, ok := analysis.scopes[scope]; ok {
		return cached
	}
	locals := map[string][]string{}
	ast.Inspect(scope, func(node ast.Node) bool {
		switch typed := node.(type) {
		case *ast.AssignStmt:
			for index, left := range typed.Lhs {
				identifier, ok := left.(*ast.Ident)
				if !ok || index >= len(typed.Rhs) {
					continue
				}
				switch typed.Tok {
				case token.DEFINE, token.ASSIGN:
					locals[identifier.Name] = analysis.stringVariants(typed.Rhs[index], []map[string][]string{locals})
				case token.ADD_ASSIGN:
					var joined []string
					for _, prefix := range locals[identifier.Name] {
						for _, suffix := range analysis.stringVariants(typed.Rhs[index], []map[string][]string{locals}) {
							joined = append(joined, prefix+suffix)
						}
					}
					locals[identifier.Name] = capVariants(joined)
				}
			}
		case *ast.DeclStmt:
			generic, ok := typed.Decl.(*ast.GenDecl)
			if !ok || (generic.Tok != token.CONST && generic.Tok != token.VAR) {
				return true
			}
			for _, spec := range generic.Specs {
				value, ok := spec.(*ast.ValueSpec)
				if !ok {
					continue
				}
				for index, name := range value.Names {
					if index >= len(value.Values) {
						continue
					}
					locals[name.Name] = analysis.stringVariants(value.Values[index], []map[string][]string{locals})
				}
			}
		}
		return true
	})
	analysis.scopes[scope] = locals
	return locals
}

const maxVariants = 8

func capVariants(values []string) []string {
	unique := make(map[string]bool, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		if unique[value] {
			continue
		}
		unique[value] = true
		out = append(out, value)
		if len(out) == maxVariants {
			break
		}
	}
	return out
}

// unresolvedFragment stands in for a string part the audit cannot see. It is
// not SQL and cannot be produced by a literal, so contains() is a reliable
// fail-closed signal. (A plain "?" would collide with the jsonb ? operator.)
const unresolvedFragment = "\x00unresolved\x00"

// stringVariants resolves every statically possible string value of an
// expression. An unknown fragment becomes unresolvedFragment so the
// surrounding keywords and $n placeholders stay visible, and the audit can
// refuse the statement instead of trusting the visible part.
func (analysis *fileAnalysis) stringVariants(expression ast.Expr, locals []map[string][]string) []string {
	switch typed := expression.(type) {
	case *ast.BasicLit:
		if typed.Kind != token.STRING {
			return nil
		}
		value, err := strconv.Unquote(typed.Value)
		if err != nil {
			return nil
		}
		return []string{value}
	case *ast.Ident:
		if values := analysis.constants[typed.Name]; len(values) > 0 {
			return values
		}
		for _, scope := range locals {
			if values := scope[typed.Name]; len(values) > 0 {
				return values
			}
		}
		return []string{unresolvedFragment}
	case *ast.BinaryExpr:
		if typed.Op != token.ADD {
			return []string{unresolvedFragment}
		}
		left := analysis.stringVariants(typed.X, locals)
		if len(left) == 0 {
			left = []string{unresolvedFragment}
		}
		right := analysis.stringVariants(typed.Y, locals)
		if len(right) == 0 {
			right = []string{unresolvedFragment}
		}
		var joined []string
		for _, prefix := range left {
			for _, suffix := range right {
				joined = append(joined, prefix+suffix)
			}
		}
		return capVariants(joined)
	case *ast.ParenExpr:
		return analysis.stringVariants(typed.X, locals)
	case *ast.IndexExpr:
		if identifier, ok := typed.X.(*ast.Ident); ok {
			if values := analysis.maps[identifier.Name]; len(values) > 0 {
				return values
			}
		}
		return []string{unresolvedFragment}
	case *ast.CallExpr:
		// A formatted statement keeps its keyword and clause structure; the
		// interpolated identifiers cannot hide a placeholder.
		name := ""
		if selector, ok := typed.Fun.(*ast.SelectorExpr); ok {
			name = selector.Sel.Name
		}
		if name == "Sprintf" && len(typed.Args) > 0 {
			var out []string
			for _, format := range analysis.stringVariants(typed.Args[0], locals) {
				out = append(out, sprintfVerbs.ReplaceAllString(format, unresolvedFragment))
			}
			return capVariants(out)
		}
		return nil
	}
	return nil
}

var sprintfVerbs = regexp.MustCompile(`%[0-9+\-.# ]*[a-zA-Z]`)

// sqlVariants is stringVariants for the statement argument; an empty result
// means the SQL cannot be resolved statically.
func (analysis *fileAnalysis) sqlVariants(expression ast.Expr, locals []map[string][]string) []string {
	values := analysis.stringVariants(expression, locals)
	out := make([]string, 0, len(values))
	for _, value := range values {
		if strings.Contains(value, unresolvedFragment) && !strings.Contains(value, "$") && !statementKeyword(value) {
			continue
		}
		out = append(out, value)
	}
	return out
}

// provablyRead is true when the first resolvable word names a statement that
// never writes rows, so an unresolved rest does not matter.
func (analysis *fileAnalysis) provablyRead(expression ast.Expr, locals []map[string][]string) bool {
	for _, value := range analysis.stringVariants(expression, locals) {
		switch firstWord(value) {
		case "SELECT", "WITH", "SHOW", "VALUES", "EXPLAIN":
			if !containsWriteKeyword(value) {
				return true
			}
		}
	}
	return false
}

func firstWord(sql string) string {
	trimmed := strings.TrimLeft(strings.TrimSpace(sql), "(")
	if index := strings.IndexAny(trimmed, " \t\r\n"); index >= 0 {
		trimmed = trimmed[:index]
	}
	return strings.ToUpper(strings.TrimSpace(trimmed))
}

func statementKeyword(sql string) bool {
	switch firstWord(sql) {
	case "SELECT", "WITH", "INSERT", "UPDATE", "DELETE", "SHOW", "VALUES", "EXPLAIN":
		return true
	}
	return false
}

func containsWriteKeyword(sql string) bool {
	upper := strings.ToUpper(sql)
	for _, keyword := range []string{"INSERT INTO", "UPDATE ", "DELETE FROM"} {
		if strings.Contains(upper, keyword) {
			return true
		}
	}
	return false
}

// placeholderKind records how a $n is used in one statement.
type placeholderKind struct {
	data   bool
	filter bool
}

// classifyStatement returns "insert", "update", "delete", "read" or "" with a
// problem. Placeholders in a WHERE/HAVING clause or after UPDATE ... FROM are
// filters; INSERT values and UPDATE SET values are payloads.
func classifyStatement(sql string) (string, map[int]placeholderKind, string) {
	kind := firstWord(sql)
	switch kind {
	case "SELECT", "SHOW", "VALUES", "EXPLAIN":
		return "read", nil, ""
	case "WITH":
		if !containsWriteKeyword(sql) {
			return "read", nil, ""
		}
		// A data-modifying CTE: classify the placeholders anyway, the caller will
		// fail if it cannot map dynamic arguments.
		kind = "update"
	case "INSERT":
		kind = "insert"
	case "UPDATE":
		kind = "update"
	case "DELETE":
		kind = "delete"
	default:
		return "", nil, "statement kind is not resolvable (starts with " + strconv.Quote(firstWord(sql)) + ")"
	}
	placeholders := map[int]placeholderKind{}
	depth := 0
	type frame struct {
		filter bool
		data   bool
	}
	stack := []frame{{}}
	current := func() *frame { return &stack[len(stack)-1] }
	words := sqlWords(sql)
	insertData := kind == "insert" || (firstWord(sql) == "WITH" && strings.Contains(strings.ToUpper(sql), "INSERT INTO"))
	updateData := false
	for _, word := range words {
		switch word.text {
		case "(":
			stack = append(stack, frame{filter: current().filter, data: current().data})
			depth++
		case ")":
			if len(stack) > 1 {
				stack = stack[:len(stack)-1]
				depth--
			}
		case "WHERE", "HAVING":
			current().filter = true
			current().data = false
		case "SET":
			if kind == "update" && !current().filter {
				updateData = true
				current().data = true
			}
		case "FROM", "RETURNING", "ORDER", "LIMIT", "GROUP", "UNION", "EXCEPT", "INTERSECT":
			if depth == 0 {
				current().filter = true
				current().data = false
			}
		case "VALUES", "SELECT":
			// The source of an INSERT is payload; a nested SELECT in a SET keeps
			// its own filter state.
		}
		if word.placeholder > 0 {
			entry := placeholders[word.placeholder]
			if kind == "delete" {
				entry.filter = true
			} else if current().filter {
				entry.filter = true
			} else if insertData {
				entry.data = true
			} else if kind == "update" && updateData && current().data {
				entry.data = true
			} else {
				// UPDATE before SET or INSERT/UPDATE in an unknown clause.
				entry.filter = true
			}
			placeholders[word.placeholder] = entry
		}
	}
	return kind, placeholders, ""
}

type sqlWord struct {
	text        string
	placeholder int
	start       int
	end         int
}

// sqlWords scans outside quoted strings and identifiers, yielding keywords and
// $n placeholders.
func sqlWords(sql string) []sqlWord {
	var words []sqlWord
	for index := 0; index < len(sql); {
		switch sql[index] {
		case '\'':
			index++
			for index < len(sql) {
				if sql[index] == '\'' {
					if index+1 < len(sql) && sql[index+1] == '\'' {
						index += 2
						continue
					}
					index++
					break
				}
				index++
			}
		case '"':
			index++
			for index < len(sql) {
				if sql[index] == '"' {
					if index+1 < len(sql) && sql[index+1] == '"' {
						index += 2
						continue
					}
					index++
					break
				}
				index++
			}
		case '-':
			if index+1 < len(sql) && sql[index+1] == '-' {
				for index < len(sql) && sql[index] != '\n' {
					index++
				}
			} else {
				index++
			}
		case '$':
			if index+1 < len(sql) && sql[index+1] >= '0' && sql[index+1] <= '9' {
				end := index + 1
				for end < len(sql) && sql[end] >= '0' && sql[end] <= '9' {
					end++
				}
				number, _ := strconv.Atoi(sql[index+1 : end])
				words = append(words, sqlWord{placeholder: number, start: index, end: end})
				index = end
			} else {
				// A dollar-quoted string body; skip it when it has a closing tag.
				if end := strings.Index(sql[index+1:], "$"); end >= 0 {
					tag := sql[index : index+1+end+1]
					if close := strings.Index(sql[index+len(tag):], tag); close >= 0 {
						index += len(tag) + close + len(tag)
						continue
					}
				}
				index++
			}
		case '(':
			words = append(words, sqlWord{text: "(", start: index, end: index + 1})
			index++
		case ')':
			words = append(words, sqlWord{text: ")", start: index, end: index + 1})
			index++
		default:
			if isLetter(sql[index]) {
				end := index
				for end < len(sql) && (isLetter(sql[end]) || sql[end] == '_') {
					end++
				}
				words = append(words, sqlWord{text: strings.ToUpper(sql[index:end]), start: index, end: end})
				index = end
			} else {
				index++
			}
		}
	}
	return words
}

func isLetter(value byte) bool {
	return value >= 'a' && value <= 'z' || value >= 'A' && value <= 'Z'
}

// argumentSlot is one value the statement binds; wrapped is true when the value
// came through db.Data/db.Text/db.JSON/db.JSONText.
type argumentSlot struct{ wrapped bool }

// argumentSlots flattens the call's value arguments, including a spread group,
// so slot[i] is placeholder $i. The second result is false when a spread cannot
// be counted statically.
func (analysis *fileAnalysis) argumentSlots(call *ast.CallExpr) ([]argumentSlot, bool) {
	values := call.Args[2:]
	slots := []argumentSlot{{}}
	for index, argument := range values {
		spread := index == len(values)-1 && call.Ellipsis.IsValid()
		var groups []argumentSlot
		var ok bool
		if spread {
			groups, ok = analysis.spreadSlots(argument, call.Pos())
		} else {
			groups = []argumentSlot{{wrapped: expressionHasWrapper(argument)}}
			ok = true
		}
		if !ok {
			return nil, false
		}
		slots = append(slots, groups...)
	}
	return slots, true
}

// mutatedArgumentSlice reports whether the spread argument of call names a
// slice that is index-assigned or appended to between its construction and the
// call. A static slot map cannot survive a later write, so the call fails
// closed.
func (analysis *fileAnalysis) mutatedArgumentSlice(call *ast.CallExpr) (string, bool) {
	if !call.Ellipsis.IsValid() || len(call.Args) == 0 {
		return "", false
	}
	identifier, ok := call.Args[len(call.Args)-1].(*ast.Ident)
	if !ok {
		if sliced, sliceOK := call.Args[len(call.Args)-1].(*ast.SliceExpr); sliceOK {
			identifier, ok = sliced.X.(*ast.Ident)
		}
	}
	if !ok {
		return "", false
	}
	name := identifier.Name
	scope := analysis.chainScope(name, call.Pos())
	if scope == nil {
		return "", false
	}
	mutated := false
	ast.Inspect(scope, func(node ast.Node) bool {
		assignment, ok := node.(*ast.AssignStmt)
		if !ok || assignment.Pos() >= call.Pos() {
			return true
		}
		for index, left := range assignment.Lhs {
			switch target := left.(type) {
			case *ast.IndexExpr:
				if inner, ok := target.X.(*ast.Ident); ok && inner.Name == name {
					mutated = true
				}
			case *ast.Ident:
				if target.Name != name || index >= len(assignment.Rhs) {
					continue
				}
				appended, ok := assignment.Rhs[index].(*ast.CallExpr)
				if !ok {
					continue
				}
				if called, named := callName(appended); !named || called != "append" || len(appended.Args) == 0 {
					continue
				}
				if first, ok := appended.Args[0].(*ast.Ident); ok && first.Name == name {
					mutated = true
				}
			}
		}
		return true
	})
	return name, mutated
}

// pureFunctions are the SQL function calls a read may contain: standard
// aggregate, string, JSON, array, date and math functions that cannot write.
// nextval/setval, set_config, pg_* side-effect APIs and graphile's add_job and
// remove_job are deliberately absent; those need a writeaudit exemption.
var pureFunctions = map[string]bool{
	"abs": true, "array_agg": true, "array_length": true, "array_position": true,
	"ascii": true, "avg": true, "btrim": true, "bool_and": true, "bool_or": true,
	"cardinality": true, "ceil": true, "ceiling": true, "char_length": true,
	"chr": true, "coalesce": true, "concat": true, "concat_ws": true, "count": true,
	"date_part": true, "date_trunc": true, "decode": true, "dense_rank": true,
	"encode": true, "every": true, "extract": true, "first_value": true,
	"floor": true, "format": true, "generate_series": true, "gen_random_uuid": true,
	"greatest": true, "initcap": true, "json_agg": true, "json_build_array": true,
	"json_build_object": true, "json_object_agg": true, "json_populate_record": true,
	"json_populate_recordset": true, "json_to_record": true, "json_to_recordset": true,
	"jsonb_agg": true, "jsonb_array_elements": true, "jsonb_array_elements_text": true,
	"jsonb_array_length": true, "jsonb_build_array": true, "jsonb_build_object": true,
	"jsonb_extract_path": true, "jsonb_extract_path_text": true, "jsonb_insert": true,
	"jsonb_object_agg": true, "jsonb_object_keys": true, "jsonb_path_exists": true,
	"jsonb_path_match": true, "jsonb_path_query": true, "jsonb_path_query_array": true,
	"jsonb_path_query_first": true, "jsonb_populate_record": true,
	"jsonb_populate_recordset": true, "jsonb_set": true, "jsonb_strip_nulls": true,
	"jsonb_to_record": true, "jsonb_to_recordset": true, "jsonb_typeof": true,
	"lag": true, "last_value": true, "lead": true, "least": true, "left": true,
	"length": true, "lower": true, "lpad": true, "ltrim": true, "make_interval": true,
	"max": true, "md5": true, "min": true, "mod": true, "now": true, "ntile": true,
	"nullif": true, "octet_length": true, "percent_rank": true, "position": true,
	"power": true, "quote_ident": true, "quote_literal": true, "random": true,
	"rank": true, "regexp_count": true, "regexp_instr": true, "regexp_match": true,
	"regexp_matches": true, "regexp_replace": true, "regexp_split_to_array": true,
	"regexp_substr": true, "repeat": true, "replace": true, "reverse": true,
	"right": true, "round": true, "row_number": true, "row_to_json": true,
	"rpad": true, "rtrim": true, "sha256": true, "sign": true, "split_part": true,
	"sqrt": true, "starts_with": true, "statement_timestamp": true, "stddev": true,
	"string_agg": true, "strpos": true, "substr": true, "substring": true, "sum": true,
	"to_char": true, "to_date": true, "to_hex": true, "to_json": true, "to_jsonb": true,
	"to_timestamp": true, "translate": true, "trim": true, "trunc": true,
	"unnest": true, "upper": true, "uuid_generate_v4": true, "variance": true,
	"width_bucket": true,
}

// sqlCallKeywords can precede "(" without being a function call.
var sqlCallKeywords = map[string]bool{
	"ALL": true, "AND": true, "ANY": true, "ARRAY": true, "AS": true,
	"BIT": true, "BY": true, "CASE": true, "CAST": true, "CHAR": true,
	"CHARACTER": true, "CONFLICT": true, "CROSS": true, "DECIMAL": true,
	"DISTINCT": true, "DO": true, "ELSE": true, "END": true, "EXCEPT": true,
	"EXISTS": true, "FILTER": true, "FROM": true, "GROUP": true, "HAVING": true,
	"IN": true, "INNER": true, "INTERSECT": true, "INTERVAL": true, "JOIN": true,
	"LATERAL": true, "LEFT": true, "LIMIT": true, "NOT": true, "NUMERIC": true,
	"OFFSET": true, "ON": true, "OR": true, "ORDER": true, "OUTER": true,
	"OVER": true, "RETURNING": true, "RIGHT": true, "SELECT": true, "SET": true,
	"SOME": true, "THEN": true, "TIME": true, "TIMESTAMP": true, "UNION": true,
	"USING": true, "VALUES": true, "VARCHAR": true, "WHEN": true, "WHERE": true,
	"WITH": true,
}

// unpureSelectCalls lists function calls in a SELECT-shaped statement that are
// not on the known-pure allowlist. Reads are otherwise skipped, so a
// data-modifying function in a projection would never be audited.
func unpureSelectCalls(sql string) []string {
	words := sqlWords(sql)
	var calls []string
	seen := map[string]bool{}
	for index, word := range words {
		if index+1 >= len(words) || words[index+1].text != "(" {
			continue
		}
		// Only an identifier directly followed by "(" is a call; a comma, an
		// alias column list (AS t(id)), a cast (::numeric(10,2)) and the like
		// are not.
		if strings.TrimSpace(sql[word.end:words[index+1].start]) != "" {
			continue
		}
		if index > 0 && (words[index-1].text == "AS" || words[index-1].text == "WITH") {
			continue
		}
		if strings.HasSuffix(strings.TrimRight(sql[:word.start], " \t\r\n"), "::") {
			continue
		}
		name := word.text
		if name == "" || name == "(" || name == ")" || !isLetter(name[0]) {
			continue
		}
		identifier := true
		for offset := 1; offset < len(name); offset++ {
			if !isLetter(name[offset]) && name[offset] != '_' {
				identifier = false
				break
			}
		}
		if !identifier || sqlCallKeywords[name] || pureFunctions[strings.ToLower(name)] || seen[name] {
			continue
		}
		seen[name] = true
		calls = append(calls, name)
	}
	return calls
}

// spreadSlots expands an expression that evaluates to []any: a boundary call,
// an append of groups, a composite literal, or a variable built once and then
// extended only by appending to itself.
func (analysis *fileAnalysis) spreadSlots(expression ast.Expr, position token.Pos) ([]argumentSlot, bool) {
	switch typed := expression.(type) {
	case *ast.CallExpr:
		name, named := callName(typed)
		if named && boundaryName(name) {
			if typed.Ellipsis.IsValid() {
				// db.Data(slice...) has no statically known length.
				return nil, false
			}
			return wrappedSlots(len(typed.Args)), true
		}
		if named && name == "append" {
			return analysis.appendSlots(typed, position)
		}
	case *ast.CompositeLit:
		slots := make([]argumentSlot, 0, len(typed.Elts))
		for _, element := range typed.Elts {
			slots = append(slots, argumentSlot{wrapped: expressionHasWrapper(element)})
		}
		return slots, true
	case *ast.Ident:
		return analysis.chainSlots(typed.Name, position)
	}
	return nil, false
}

// appendSlots expands append(base, values...): the base slice plus each value.
func (analysis *fileAnalysis) appendSlots(call *ast.CallExpr, position token.Pos) ([]argumentSlot, bool) {
	if len(call.Args) == 0 {
		return nil, false
	}
	slots, ok := analysis.spreadSlots(call.Args[0], position)
	if !ok {
		return nil, false
	}
	extra, ok := analysis.appendValues(call, position)
	if !ok {
		return nil, false
	}
	return append(slots, extra...), true
}

// appendValues expands the values of append(base, values...), excluding base.
func (analysis *fileAnalysis) appendValues(call *ast.CallExpr, position token.Pos) ([]argumentSlot, bool) {
	values := call.Args[1:]
	var slots []argumentSlot
	for index, argument := range values {
		last := index == len(values)-1 && call.Ellipsis.IsValid()
		if last {
			groups, ok := analysis.spreadSlots(argument, position)
			if !ok {
				return nil, false
			}
			slots = append(slots, groups...)
			continue
		}
		slots = append(slots, argumentSlot{wrapped: expressionHasWrapper(argument)})
	}
	return slots, true
}

// chainSlots resolves a variable that is assigned once and then only extended
// with append(name, ...): the arrays and args builders at the write sites. The
// search block is the innermost one holding an assignment to the name, so two
// branches that each build their own "arguments" stay separate.
func (analysis *fileAnalysis) chainSlots(name string, position token.Pos) ([]argumentSlot, bool) {
	scope := analysis.chainScope(name, position)
	if scope == nil {
		return nil, false
	}
	block, ok := scope.(*ast.BlockStmt)
	if !ok {
		return nil, false
	}
	var initial ast.Expr
	var appends []*ast.CallExpr
	found := false
	for _, statement := range block.List {
		assignment, ok := statement.(*ast.AssignStmt)
		if !ok {
			continue
		}
		for index, left := range assignment.Lhs {
			identifier, ok := left.(*ast.Ident)
			if !ok || identifier.Name != name || index >= len(assignment.Rhs) {
				continue
			}
			right := assignment.Rhs[index]
			if !found {
				found = true
				if assignment.Tok != token.DEFINE && assignment.Tok != token.ASSIGN {
					return nil, false
				}
				if call, ok := right.(*ast.CallExpr); ok {
					if called, named := callName(call); named && called == "append" && len(call.Args) > 0 {
						// args := append(base, ...) is fine unless it appends to itself.
						if first, ok := call.Args[0].(*ast.Ident); ok && first.Name == name {
							return nil, false
						}
					}
				}
				initial = right
				continue
			}
			if assignment.Tok != token.ASSIGN {
				return nil, false
			}
			call, ok := right.(*ast.CallExpr)
			if !ok {
				return nil, false
			}
			if called, named := callName(call); !named || called != "append" || len(call.Args) == 0 {
				return nil, false
			}
			first, ok := call.Args[0].(*ast.Ident)
			if !ok || first.Name != name {
				return nil, false
			}
			appends = append(appends, call)
		}
	}
	if !found {
		return nil, false
	}
	// A closure that also appends to the builder makes the list depend on runtime
	// branches (place/placeData in events.Append); only direct statements are static.
	if closureMutates(block, name) {
		return nil, false
	}
	slots, ok := analysis.spreadSlots(initial, position)
	if !ok {
		return nil, false
	}
	for _, appendCall := range appends {
		extra, ok := analysis.appendValues(appendCall, position)
		if !ok {
			return nil, false
		}
		slots = append(slots, extra...)
	}
	return slots, true
}

// chainScope picks the innermost block around position that assigns name; a
// two-branch function then resolves each branch's own builder.
func (analysis *fileAnalysis) chainScope(name string, position token.Pos) ast.Node {
	var best ast.Node
	ast.Inspect(analysis.file, func(node ast.Node) bool {
		block, ok := node.(*ast.BlockStmt)
		if !ok || node.Pos() > position || position > node.End() {
			return true
		}
		if best != nil && node.End()-node.Pos() >= best.End()-best.Pos() {
			return true
		}
		if assignsName(block, name) {
			best = block
		}
		return true
	})
	return best
}

func blockAssignments(block *ast.BlockStmt, name string) []*ast.AssignStmt {
	var out []*ast.AssignStmt
	for _, statement := range block.List {
		assignment, ok := statement.(*ast.AssignStmt)
		if !ok {
			continue
		}
		for _, left := range assignment.Lhs {
			if identifier, ok := left.(*ast.Ident); ok && identifier.Name == name {
				out = append(out, assignment)
				break
			}
		}
	}
	return out
}

func closureMutates(block *ast.BlockStmt, name string) bool {
	mutated := false
	ast.Inspect(block, func(node ast.Node) bool {
		if mutated {
			return false
		}
		literal, ok := node.(*ast.FuncLit)
		if !ok {
			return true
		}
		ast.Inspect(literal, func(candidate ast.Node) bool {
			assignment, ok := candidate.(*ast.AssignStmt)
			if !ok {
				return true
			}
			for _, left := range assignment.Lhs {
				if identifier, ok := left.(*ast.Ident); ok && identifier.Name == name {
					mutated = true
					return false
				}
			}
			return true
		})
		return false
	})
	return mutated
}

func assignsName(node ast.Node, name string) bool {
	block, ok := node.(*ast.BlockStmt)
	if !ok {
		return false
	}
	for _, statement := range block.List {
		assignment, ok := statement.(*ast.AssignStmt)
		if !ok {
			continue
		}
		for _, left := range assignment.Lhs {
			if identifier, ok := left.(*ast.Ident); ok && identifier.Name == name {
				return true
			}
		}
	}
	return false
}

func callName(call *ast.CallExpr) (string, bool) {
	switch typed := call.Fun.(type) {
	case *ast.Ident:
		return typed.Name, true
	case *ast.SelectorExpr:
		return typed.Sel.Name, true
	}
	return "", false
}

func boundaryName(name string) bool {
	switch name {
	case "Data", "Text", "JSON", "JSONText":
		return true
	}
	return false
}

func wrappedSlots(count int) []argumentSlot {
	slots := make([]argumentSlot, count)
	for index := range slots {
		slots[index].wrapped = true
	}
	return slots
}

// expressionHasWrapper reports whether the expression itself is a boundary
// call; a nested wrapper inside an ordinary expression does not count as the
// value's declaration.
func expressionHasWrapper(expression ast.Expr) bool {
	call, ok := expression.(*ast.CallExpr)
	if !ok {
		return false
	}
	name, ok := callName(call)
	return ok && boundaryName(name)
}
