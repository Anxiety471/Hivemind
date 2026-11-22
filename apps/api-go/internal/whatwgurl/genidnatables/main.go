// Command genidnatables turns the committed Node/ICU and UCD probe outputs in
// internal/whatwgurl/testdata into the compact range-encoded Go tables used by
// the UTS #46 host parser. Run it with `go generate ./internal/whatwgurl`.
package main

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"flag"
	"fmt"
	"go/format"
	"io"
	"os"
	"sort"
	"strconv"
)

type mappingFile struct {
	Meta struct {
		Source  string `json:"source"`
		Node    string `json:"node"`
		ICU     string `json:"icu"`
		Unicode string `json:"unicode"`
		V8      string `json:"v8"`
	} `json:"meta"`
	Mappings []string `json:"mappings"`
	Ranges   [][5]int `json:"ranges"`
}

type bidiFile struct {
	Meta struct {
		Source  string `json:"source"`
		Node    string `json:"node"`
		ICU     string `json:"icu"`
		Unicode string `json:"unicode"`
	} `json:"meta"`
	Ranges [][3]int `json:"ranges"`
}

type contextFile struct {
	Meta struct {
		Source  string `json:"source"`
		Node    string `json:"node"`
		ICU     string `json:"icu"`
		Unicode string `json:"unicode"`
		V8      string `json:"v8"`
		UCD     string `json:"ucd"`
		Tested  int    `json:"tested"`
	} `json:"meta"`
	NFCStarters [][2]int `json:"nfcStarters"`
	JoinerLeft  [][2]int `json:"joinerLeft"`
	JoinerRight [][2]int `json:"joinerRight"`
	Viramas     [][2]int `json:"viramas"`
	Anomalies   []any    `json:"anomalies"`
}

type probeVersions struct {
	node    string
	icu     string
	unicode string
}

func versionsOf(node, icu, unicode string) probeVersions {
	return probeVersions{node: node, icu: icu, unicode: unicode}
}

// requireSameProbes refuses to generate tables from probe files that were
// produced by different host parsers. Mixing them silently would make the
// generated constants describe only one of the inputs.
func requireSameProbes(want probeVersions, name string, got probeVersions) error {
	if got.node == "" || got.icu == "" || got.unicode == "" {
		return fmt.Errorf("%s probe has incomplete version metadata: Node %q, ICU %q, Unicode %q", name, got.node, got.icu, got.unicode)
	}
	if got != want {
		return fmt.Errorf("%s probe was generated with Node %q, ICU %q, Unicode %q; the mapping probe uses Node %q, ICU %q, Unicode %q", name, got.node, got.icu, got.unicode, want.node, want.icu, want.unicode)
	}
	return nil
}

func readGzipJSON(path string, v any) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	defer gz.Close()
	data, err := io.ReadAll(gz)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, v)
}

func checkCoverage(name string, ranges [][3]int) error {
	if len(ranges) == 0 {
		return fmt.Errorf("%s: empty", name)
	}
	if ranges[0][0] != 0 || ranges[len(ranges)-1][1] != 0x10ffff {
		return fmt.Errorf("%s: does not cover 0..0x10FFFF", name)
	}
	for i, r := range ranges {
		if r[0] > r[1] {
			return fmt.Errorf("%s: range %d inverted", name, i)
		}
		if i > 0 && ranges[i-1][1]+1 != r[0] {
			return fmt.Errorf("%s: gap or overlap before range %d", name, i)
		}
	}
	return nil
}

func main() {
	mappingPath := flag.String("mapping", "testdata/idna-mapping.json.gz", "Node/ICU mapping probe")
	bidiPath := flag.String("bidi", "testdata/idna-bidi.json.gz", "Node/ICU effective Bidi probe")
	contextPath := flag.String("context", "testdata/idna-context.json.gz", "Node/ICU ContextJ and NFC probe")
	outPath := flag.String("out", "idna_tables_gen.go", "generated Go file")
	flag.Parse()

	var mf mappingFile
	if err := readGzipJSON(*mappingPath, &mf); err != nil {
		fmt.Fprintln(os.Stderr, "mapping:", err)
		os.Exit(1)
	}
	var bf bidiFile
	if err := readGzipJSON(*bidiPath, &bf); err != nil {
		fmt.Fprintln(os.Stderr, "bidi:", err)
		os.Exit(1)
	}
	var cf contextFile
	if err := readGzipJSON(*contextPath, &cf); err != nil {
		fmt.Fprintln(os.Stderr, "context:", err)
		os.Exit(1)
	}
	versions := versionsOf(mf.Meta.Node, mf.Meta.ICU, mf.Meta.Unicode)
	for _, probe := range []struct {
		name string
		got  probeVersions
	}{
		{"mapping", versionsOf(mf.Meta.Node, mf.Meta.ICU, mf.Meta.Unicode)},
		{"bidi", versionsOf(bf.Meta.Node, bf.Meta.ICU, bf.Meta.Unicode)},
		{"context", versionsOf(cf.Meta.Node, cf.Meta.ICU, cf.Meta.Unicode)},
	} {
		if err := requireSameProbes(versions, probe.name, probe.got); err != nil {
			fmt.Fprintln(os.Stderr, "probe metadata:", err)
			os.Exit(1)
		}
	}
	if err := checkCoverage("bidi", bf.Ranges); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if len(mf.Mappings) == 0 || mf.Mappings[0] != "" {
		fmt.Fprintln(os.Stderr, "mapping: first mapping must be empty")
		os.Exit(1)
	}
	if len(mf.Ranges) == 0 {
		fmt.Fprintln(os.Stderr, "mapping: empty ranges")
		os.Exit(1)
	}
	if mf.Ranges[0][0] != 0 || mf.Ranges[len(mf.Ranges)-1][1] > 0x10ffff {
		fmt.Fprintln(os.Stderr, "mapping: ranges do not start at 0 or exceed 0x10FFFF")
		os.Exit(1)
	}
	for i, r := range mf.Ranges {
		if r[0] > r[1] {
			fmt.Fprintf(os.Stderr, "mapping: range %d inverted\n", i)
			os.Exit(1)
		}
		if i > 0 && (mf.Ranges[i-1][1]+1 != r[0] && !(mf.Ranges[i-1][1] == 0xd7ff && r[0] == 0xe000)) {
			fmt.Fprintf(os.Stderr, "mapping: gap or overlap before range %d\n", i)
			os.Exit(1)
		}
		if r[2] == 1 && (r[4] <= 0 || r[4] >= len(mf.Mappings)) {
			fmt.Fprintf(os.Stderr, "mapping: bad mapping index in range %d\n", i)
			os.Exit(1)
		}
	}
	if len(cf.Anomalies) != 0 {
		fmt.Fprintf(os.Stderr, "context: %d probe anomalies\n", len(cf.Anomalies))
		os.Exit(1)
	}
	for name, ranges := range map[string][][2]int{
		"nfcStarters": cf.NFCStarters,
		"joinerLeft":  cf.JoinerLeft,
		"joinerRight": cf.JoinerRight,
		"viramas":     cf.Viramas,
	} {
		if !sort.SliceIsSorted(ranges, func(i, j int) bool { return ranges[i][0] < ranges[j][0] }) {
			fmt.Fprintf(os.Stderr, "context: %s ranges unsorted\n", name)
			os.Exit(1)
		}
		for i := 1; i < len(ranges); i++ {
			if ranges[i-1][1] >= ranges[i][0] {
				fmt.Fprintf(os.Stderr, "context: %s ranges overlap\n", name)
				os.Exit(1)
			}
		}
	}

	// Concatenate the mapped strings into one blob and remember byte offsets.
	var blob []byte
	offsets := make([]uint32, len(mf.Mappings))
	lengths := make([]uint32, len(mf.Mappings))
	offsets[0] = 0
	lengths[0] = 0
	for i := 1; i < len(mf.Mappings); i++ {
		offsets[i] = uint32(len(blob))
		lengths[i] = uint32(len(mf.Mappings[i]))
		blob = append(blob, mf.Mappings[i]...)
	}

	var buf bytes.Buffer
	w := &buf
	fmt.Fprintf(w, "// Code generated by go run ./genidnatables; DO NOT EDIT.\n")
	fmt.Fprintf(w, "//\n")
	fmt.Fprintf(w, "// UTS #46 mapping and leading-code-point data: %s\n", mf.Meta.Source)
	fmt.Fprintf(w, "// Generated from Node %s, ICU %s, Unicode %s, V8 %s.\n", mf.Meta.Node, mf.Meta.ICU, mf.Meta.Unicode, mf.Meta.V8)
	fmt.Fprintf(w, "// Effective Bidi classes: %s\n", bf.Meta.Source)
	fmt.Fprintf(w, "// ContextJ and NFC context probes: %s.\n", cf.Meta.Source)
	fmt.Fprintf(w, "// Effective corpus: %s\n", cf.Meta.UCD)
	fmt.Fprintf(w, "// Tested %d valid code points.\n", cf.Meta.Tested)
	fmt.Fprintf(w, "\npackage whatwgurl\n\n")

	fmt.Fprintf(w, "// NodeVersion, ICUVersion and UnicodeVersion pin the host parser that\n")
	fmt.Fprintf(w, "// produced the tables below. Regenerate them with the same runtime when\n")
	fmt.Fprintf(w, "// any of these changes.\n")
	fmt.Fprintf(w, "const (\n")
	fmt.Fprintf(w, "\tNodeVersion = %q\n", versions.node)
	fmt.Fprintf(w, "\tICUVersion = %q\n", versions.icu)
	fmt.Fprintf(w, "\tUnicodeVersion = %q\n", versions.unicode)
	fmt.Fprintf(w, ")\n\n")

	fmt.Fprintf(w, "const (\n")
	fmt.Fprintf(w, "\tidnaStatusValid uint8 = iota\n")
	fmt.Fprintf(w, "\tidnaStatusMapped\n")
	fmt.Fprintf(w, "\tidnaStatusIgnored\n")
	fmt.Fprintf(w, "\tidnaStatusDisallowed\n")
	fmt.Fprintf(w, ")\n\n")

	fmt.Fprintf(w, "const (\n")
	fmt.Fprintf(w, "\tbidiClassL uint8 = iota\n")
	fmt.Fprintf(w, "\tbidiClassRT\n")
	fmt.Fprintf(w, "\tbidiClassEN\n")
	fmt.Fprintf(w, "\tbidiClassAN\n")
	fmt.Fprintf(w, "\tbidiClassNSM\n")
	fmt.Fprintf(w, "\tbidiClassNeutral\n")
	fmt.Fprintf(w, "\tbidiClassInvalid\n")
	fmt.Fprintf(w, ")\n\n")

	fmt.Fprintf(w, "type idnaRange struct {\n")
	fmt.Fprintf(w, "\tlo, hi  rune\n")
	fmt.Fprintf(w, "\tstatus  uint8\n")
	fmt.Fprintf(w, "\tfirst   bool\n")
	fmt.Fprintf(w, "\tmapOff  uint32\n")
	fmt.Fprintf(w, "\tmapLen  uint32\n")
	fmt.Fprintf(w, "}\n\n")
	fmt.Fprintf(w, "var idnaRanges = [...]idnaRange{\n")
	for _, r := range mf.Ranges {
		off, length := uint32(0), uint32(0)
		if r[2] == 1 {
			off, length = offsets[r[4]], lengths[r[4]]
		}
		fmt.Fprintf(w, "\t{0x%X, 0x%X, %d, %t, %d, %d},\n", r[0], r[1], r[2], r[3] != 0, off, length)
	}
	fmt.Fprintf(w, "}\n\n")

	fmt.Fprintf(w, "const idnaMappingBlob = %s\n\n", strconv.Quote(string(blob)))

	fmt.Fprintf(w, "type bidiRange struct {\n")
	fmt.Fprintf(w, "\tlo, hi rune\n")
	fmt.Fprintf(w, "\tclass  uint8\n")
	fmt.Fprintf(w, "}\n\n")
	fmt.Fprintf(w, "var bidiRanges = [...]bidiRange{\n")
	for _, r := range bf.Ranges {
		fmt.Fprintf(w, "\t{0x%X, 0x%X, %d},\n", r[0], r[1], r[2])
	}
	fmt.Fprintf(w, "}\n\n")

	fmt.Fprintf(w, "type codePointRange struct {\n")
	fmt.Fprintf(w, "\tlo, hi rune\n")
	fmt.Fprintf(w, "}\n\n")
	for _, group := range []struct {
		name   string
		ranges [][2]int
	}{
		{"nfcStarterRanges", cf.NFCStarters},
		{"joinerLeftRanges", cf.JoinerLeft},
		{"joinerRightRanges", cf.JoinerRight},
		{"viramaRanges", cf.Viramas},
	} {
		fmt.Fprintf(w, "var %s = [...]codePointRange{\n", group.name)
		for _, r := range group.ranges {
			fmt.Fprintf(w, "\t{0x%X, 0x%X},\n", r[0], r[1])
		}
		fmt.Fprintf(w, "}\n\n")
	}

	formatted, err := format.Source(buf.Bytes())
	if err != nil {
		fmt.Fprintln(os.Stderr, "format generated source:", err)
		os.Exit(1)
	}
	if err := os.WriteFile(*outPath, formatted, 0o644); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
