package db

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// TestWriteStatementsUseTheDataBoundary fails when an INSERT or UPDATE passes a
// payload argument that has not gone through db.Data/db.Text/db.JSON/db.JSONText.
// Filters, DELETE and reads are deliberately exempt: Prisma never sanitizes
// them, so a NUL in a WHERE must reach PostgreSQL unchanged.
func TestWriteStatementsUseTheDataBoundary(t *testing.T) {
	root := filepath.Join("..", "..")
	directories := []string{
		"internal/procedures",
		"internal/runs",
		"internal/events",
		"internal/effects",
		"internal/drive",
		"internal/memoryroam",
		"internal/auth",
		"internal/contentcrypto",
	}
	var violations []string
	for _, directory := range directories {
		err := filepath.Walk(filepath.Join(root, filepath.FromSlash(directory)), func(path string, info os.FileInfo, walkErr error) error {
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
			files := token.NewFileSet()
			file, err := parser.ParseFile(files, path, nil, parser.ParseComments)
			if err != nil {
				t.Fatalf("parse %s: %v", relative, err)
			}
			constants := stringConstants(file)
			dataVars := variablesWithBoundary(file)
			ast.Inspect(file, func(node ast.Node) bool {
				call, ok := node.(*ast.CallExpr)
				if !ok {
					return true
				}
				selector, ok := call.Fun.(*ast.SelectorExpr)
				if !ok || (selector.Sel.Name != "Exec" && selector.Sel.Name != "Query" && selector.Sel.Name != "QueryRow") {
					return true
				}
				if len(call.Args) < 2 {
					return true
				}
				sql := resolveString(call.Args[1], constants)
				keyword := normalizeSQL(strings.ToUpper(strings.TrimLeft(sql, " \t\r\n(")))
				if !statementNeedsBoundary(keyword) {
					return true
				}
				for _, argument := range call.Args[2:] {
					if hasBoundaryWrapper(argument) {
						return true
					}
					if identifier, ok := argument.(*ast.Ident); ok && dataVars[identifier.Name] {
						return true
					}
					if ellipsis, ok := argument.(*ast.Ellipsis); ok {
						if identifier, ok := ellipsis.Elt.(*ast.Ident); ok && dataVars[identifier.Name] {
							return true
						}
					}
				}
				line := files.Position(call.Pos()).Line
				violations = append(violations, relative+":"+strconv.Itoa(line)+" "+firstLine(sql))
				return true
			})
			return nil
		})
		if err != nil {
			t.Fatalf("walk %s: %v", directory, err)
		}
	}
	if len(violations) > 0 {
		t.Fatalf("write payloads bypass db.Data/db.Text/db.JSON/db.JSONText:\n%s", strings.Join(violations, "\n"))
	}
}

// normalizeSQL collapses whitespace so SET/WHERE/VALUES are single spaces.
func normalizeSQL(sql string) string {
	return strings.Join(strings.Fields(sql), " ")
}

// statementNeedsBoundary reports whether the statement binds a data value: a
// SET clause with a placeholder, or VALUES with a placeholder. A statement whose
// only placeholders are filters (or that has none) needs no wrapper.
func statementNeedsBoundary(uppercase string) bool {
	if strings.HasPrefix(uppercase, "INSERT ") {
		values := strings.Index(uppercase, " VALUES ")
		return values >= 0 && strings.Contains(uppercase[values:], "$")
	}
	if strings.HasPrefix(uppercase, "UPDATE ") {
		set := strings.Index(uppercase, " SET ")
		if set < 0 {
			return false
		}
		end := strings.Index(uppercase[set:], " WHERE ")
		clause := uppercase[set:]
		if end >= 0 {
			clause = uppercase[set : set+end]
		}
		return strings.Contains(clause, "$")
	}
	return false
}

func firstLine(sql string) string {
	if index := strings.IndexByte(sql, '\n'); index >= 0 {
		sql = sql[:index]
	}
	if len(sql) > 90 {
		sql = sql[:90]
	}
	return strings.TrimSpace(sql)
}

// variablesWithBoundary records variables assigned from a Data/Text/JSON call
// (or an append of one), which the statement then passes with `...`.
func variablesWithBoundary(file *ast.File) map[string]bool {
	variables := map[string]bool{}
	ast.Inspect(file, func(node ast.Node) bool {
		assignment, ok := node.(*ast.AssignStmt)
		if !ok {
			return true
		}
		for index, right := range assignment.Rhs {
			if !hasBoundaryWrapper(right) {
				continue
			}
			if index < len(assignment.Lhs) {
				if identifier, ok := assignment.Lhs[index].(*ast.Ident); ok {
					variables[identifier.Name] = true
				}
			}
		}
		return true
	})
	return variables
}

func stringConstants(file *ast.File) map[string]string {
	constants := map[string]string{}
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
				if text, ok := literalString(value.Values[index]); ok {
					constants[name.Name] = text
				}
			}
		}
	}
	return constants
}

func resolveString(expression ast.Expr, constants map[string]string) string {
	if text, ok := literalString(expression); ok {
		return text
	}
	if identifier, ok := expression.(*ast.Ident); ok {
		return constants[identifier.Name]
	}
	return ""
}

// literalString folds a concatenation of string literals, which is how the
// largest statements are written.
func literalString(expression ast.Expr) (string, bool) {
	switch typed := expression.(type) {
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
		left, leftOK := literalString(typed.X)
		right, rightOK := literalString(typed.Y)
		if !leftOK || !rightOK {
			return "", false
		}
		return left + right, true
	case *ast.ParenExpr:
		return literalString(typed.X)
	}
	return "", false
}

func hasBoundaryWrapper(expression ast.Expr) bool {
	found := false
	ast.Inspect(expression, func(node ast.Node) bool {
		call, ok := node.(*ast.CallExpr)
		if !ok {
			return true
		}
		name := ""
		switch typed := call.Fun.(type) {
		case *ast.Ident:
			name = typed.Name
		case *ast.SelectorExpr:
			name = typed.Sel.Name
		}
		switch name {
		case "Data", "Text", "JSON", "JSONText":
			found = true
			return false
		}
		return true
	})
	return found
}
