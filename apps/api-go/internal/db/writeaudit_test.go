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
	var violations []string
	var exemptions []string
	for _, directory := range []string{"internal", "cmd"} {
		err := filepath.Walk(filepath.Join(root, directory), func(path string, info os.FileInfo, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if info.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
				return nil
			}
			relative, err := filepath.Rel(root, path)
			if err != nil {
				return err
			}
			fset := token.NewFileSet()
			file, err := parser.ParseFile(fset, path, nil, parser.ParseComments)
			if err != nil {
				t.Fatalf("parse %s: %v", relative, err)
			}
			analysis := newFileAnalysis(file)
			ast.Inspect(file, func(node ast.Node) bool {
				call, ok := node.(*ast.CallExpr)
				if !ok {
					return true
				}
				selector, ok := call.Fun.(*ast.SelectorExpr)
				if !ok || (selector.Sel.Name != "Exec" && selector.Sel.Name != "Query" && selector.Sel.Name != "QueryRow") {
					return true
				}
				// A statement with no bound values cannot bypass the boundary.
				if len(call.Args) < 3 {
					return true
				}
				position := fset.Position(call.Pos())
				where := relative + ":" + strconv.Itoa(position.Line)
				locals := analysis.localsAt(call.Pos())
				variants := analysis.sqlVariants(call.Args[1], locals)
				if len(variants) == 0 {
					if analysis.provablyRead(call.Args[1], locals) {
						return true
					}
					if reason, ok := exemption(file, fset, call); ok {
						exemptions = append(exemptions, where+" "+reason)
					} else {
						violations = append(violations, where+" SQL is not statically resolvable; add //writeaudit:dynamic <reason>")
					}
					return true
				}
				for _, sql := range variants {
					kind, placeholders, problem := classifyStatement(sql)
					if problem != "" {
						if reason, ok := exemption(file, fset, call); ok {
							exemptions = append(exemptions, where+" "+reason)
							return true
						}
						violations = append(violations, where+" "+problem)
						return true
					}
					if kind == "read" {
						continue
					}
					if kind == "delete" {
						slots, resolved := analysis.argumentSlots(call)
						if !resolved {
							if reason, ok := exemption(file, fset, call); ok {
								exemptions = append(exemptions, where+" "+reason)
							} else {
								violations = append(violations, where+" DELETE argument list is not statically auditable; add //writeaudit:dynamic <reason>")
							}
							continue
						}
						for index, slot := range slots[1:] {
							if slot.wrapped {
								violations = append(violations, where+" DELETE $"+strconv.Itoa(index)+" is wrapped; filters must stay unwrapped")
								return true
							}
						}
						continue
					}
					slots, resolved := analysis.argumentSlots(call)
					if !resolved {
						if reason, ok := exemption(file, fset, call); ok {
							exemptions = append(exemptions, where+" "+reason)
							return true
						}
						violations = append(violations, where+" argument list is not statically auditable; add //writeaudit:dynamic <reason>")
						return true
					}
					if len(slots) != len(placeholders)+1 {
						violations = append(violations, where+" binds "+strconv.Itoa(len(slots)-1)+" arguments for "+strconv.Itoa(len(placeholders))+" placeholders")
						return true
					}
					for index := 1; index <= len(placeholders); index++ {
						slot := slots[index]
						data := placeholders[index].data
						filter := placeholders[index].filter
						if data && !slot.wrapped {
							violations = append(violations, where+" $"+strconv.Itoa(index)+" is a payload but is not wrapped in db.Data/db.Text/db.JSON/db.JSONText")
							return true
						}
						if filter && slot.wrapped {
							violations = append(violations, where+" $"+strconv.Itoa(index)+" is a filter but is wrapped")
							return true
						}
						if data && filter {
							violations = append(violations, where+" $"+strconv.Itoa(index)+" is used as both payload and filter")
							return true
						}
					}
				}
				return true
			})
			return nil
		})
		if err != nil {
			t.Fatalf("walk %s: %v", directory, err)
		}
	}
	for _, exemption := range exemptions {
		t.Logf("writeaudit exemption: %s", exemption)
	}
	if len(violations) > 0 {
		t.Fatalf("write boundary violations:\n%s", strings.Join(violations, "\n"))
	}
}

// exemption reports the reason on a //writeaudit:dynamic comment attached to the
// call's statement, or to the call line itself.
func exemption(file *ast.File, fset *token.FileSet, call *ast.CallExpr) (string, bool) {
	line := fset.Position(call.Pos()).Line
	for _, group := range file.Comments {
		start := fset.Position(group.Pos()).Line
		if start < line-1 || start > line {
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
		assignment, ok := node.(*ast.AssignStmt)
		if !ok {
			return true
		}
		for index, left := range assignment.Lhs {
			identifier, ok := left.(*ast.Ident)
			if !ok || index >= len(assignment.Rhs) {
				continue
			}
			switch assignment.Tok {
			case token.DEFINE, token.ASSIGN:
				locals[identifier.Name] = analysis.stringVariants(assignment.Rhs[index], []map[string][]string{locals})
			case token.ADD_ASSIGN:
				var joined []string
				for _, prefix := range locals[identifier.Name] {
					for _, suffix := range analysis.stringVariants(assignment.Rhs[index], []map[string][]string{locals}) {
						joined = append(joined, prefix+suffix)
					}
				}
				locals[identifier.Name] = capVariants(joined)
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

// stringVariants resolves every statically possible string value of an
// expression. An unknown fragment becomes "?" so the surrounding keywords and
// $n placeholders stay visible.
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
		return []string{"?"}
	case *ast.BinaryExpr:
		if typed.Op != token.ADD {
			return []string{"?"}
		}
		left := analysis.stringVariants(typed.X, locals)
		if len(left) == 0 {
			left = []string{"?"}
		}
		right := analysis.stringVariants(typed.Y, locals)
		if len(right) == 0 {
			right = []string{"?"}
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
		return []string{"?"}
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
				out = append(out, sprintfVerbs.ReplaceAllString(format, "?"))
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
		if strings.Contains(value, "?") && !strings.Contains(value, "$") && !statementKeyword(value) {
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
				words = append(words, sqlWord{placeholder: number})
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
			words = append(words, sqlWord{text: "("})
			index++
		case ')':
			words = append(words, sqlWord{text: ")"})
			index++
		default:
			if isLetter(sql[index]) {
				end := index
				for end < len(sql) && (isLetter(sql[end]) || sql[end] == '_') {
					end++
				}
				words = append(words, sqlWord{text: strings.ToUpper(sql[index:end])})
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
