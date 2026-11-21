// Command mdtextdiff runs internal/mdtext over a corpus of Markdown sources and
// writes the results, for tools/mdtext-diff.mts to compare with the TypeScript.
//
// Corpus (little endian): repeated records of
//
//	uint32 maxSource
//	uint32 maxChars
//	uint32 length
//	length * uint16 UTF-16 code units
//
// Result, per record:
//
//	uint32 lengthA, A units  (plainTextFromMarkdown(markdown, {maxSource}))
//	uint32 lengthB, B units  (truncatedPlainText(markdown, maxChars))
//	uint32 lengthC, C units  (truncatePlainText(A, maxChars))
//	uint32 D                 (shortenedTextLength(A))
//	uint32 E                 (textBoundary(A, maxChars))
package main

import (
	"encoding/binary"
	"flag"
	"fmt"
	"os"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/mdtext"
)

func main() {
	corpusPath := flag.String("in", "", "corpus file")
	resultPath := flag.String("out", "", "result file")
	flag.Parse()
	if *corpusPath == "" || *resultPath == "" {
		fmt.Fprintln(os.Stderr, "mdtextdiff: -in and -out are required")
		os.Exit(2)
	}
	data, err := os.ReadFile(*corpusPath)
	if err != nil {
		fatal(err)
	}
	out := make([]byte, 0, len(data)/2)
	offset := 0
	readUint32 := func() uint32 {
		if offset+4 > len(data) {
			fatal(fmt.Errorf("truncated corpus at %d", offset))
		}
		value := binary.LittleEndian.Uint32(data[offset:])
		offset += 4
		return value
	}
	writeUint32 := func(value uint32) {
		out = binary.LittleEndian.AppendUint32(out, value)
	}
	writeUnits := func(units []uint16) {
		writeUint32(uint32(len(units)))
		for _, unit := range units {
			out = binary.LittleEndian.AppendUint16(out, unit)
		}
	}
	records := 0
	for offset < len(data) {
		maxSource := int(readUint32())
		maxChars := int(readUint32())
		length := int(readUint32())
		if offset+2*length > len(data) {
			fatal(fmt.Errorf("truncated record %d at %d", records, offset))
		}
		source := make([]uint16, length)
		for index := range source {
			source[index] = binary.LittleEndian.Uint16(data[offset+2*index:])
		}
		offset += 2 * length
		plain := mdtext.PlainTextFromMarkdownUnits(source, maxSource)
		writeUnits(plain)
		writeUnits(mdtext.TruncatedPlainTextUnits(source, maxChars))
		writeUnits(mdtext.TruncatePlainTextUnits(plain, maxChars))
		writeUint32(uint32(mdtext.ShortenedTextLength(plain)))
		writeUint32(uint32(mdtext.TextBoundary(plain, maxChars)))
		records++
	}
	if err := os.WriteFile(*resultPath, out, 0o600); err != nil {
		fatal(err)
	}
	fmt.Fprintf(os.Stderr, "mdtextdiff: %d records\n", records)
}

func fatal(err error) {
	fmt.Fprintf(os.Stderr, "mdtextdiff: %v\n", err)
	os.Exit(1)
}
