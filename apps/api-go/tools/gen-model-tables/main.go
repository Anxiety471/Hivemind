// Command gen-model-tables regenerates the catalog-derived Go tables
// (internal/procedures/modelcredentials/tables_gen.go) from the pinned pi-ai provider data and
// the TypeScript endpoint presets. Run it from apps/api-go after a dependency bump or a preset
// change; the package's drift test fails until it is run.
//
//	cd apps/api-go
//	go run ./tools/gen-model-tables
//	go run ./tools/gen-model-tables -check
package main

import (
	"bytes"
	"flag"
	"fmt"
	"os"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/modelcredentials/gentables"
)

func main() {
	piPath := flag.String("pi", "../../packages/adapters/node_modules/@earendil-works/pi-ai/dist/providers/data/anthropic.json",
		"pi-ai anthropic provider data")
	presetPath := flag.String("presets", "../../packages/adapters/src/models/endpoints/openai-compatible-url.ts",
		"TypeScript endpoint presets source")
	output := flag.String("o", "internal/procedures/modelcredentials/tables_gen.go",
		"generated Go file")
	check := flag.Bool("check", false, "compare instead of writing; exit 1 on drift")
	flag.Parse()

	generated, err := gentables.Generate(*piPath, *presetPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "gen-model-tables:", err)
		os.Exit(1)
	}
	if *check {
		committed, err := os.ReadFile(*output)
		if err != nil {
			fmt.Fprintln(os.Stderr, "gen-model-tables:", err)
			os.Exit(1)
		}
		if !bytes.Equal(generated, committed) {
			fmt.Fprintln(os.Stderr, "gen-model-tables: generated tables differ from", *output, "- run go run ./apps/api-go/tools/gen-model-tables")
			os.Exit(1)
		}
		return
	}
	if err := os.WriteFile(*output, generated, 0o644); err != nil {
		fmt.Fprintln(os.Stderr, "gen-model-tables:", err)
		os.Exit(1)
	}
}
