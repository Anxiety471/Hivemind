// Command wtf8proof is the Go half of the lone-surrogate boundary proof. It
// reads a JSON-lines corpus of {"id","value"} records, decodes each value with
// internal/wtf8 (the gateway's request boundary) and writes the value back with
// internal/wtf8.Marshal, which is JSON.stringify's spelling. The TypeScript
// driver compares each record with JSON.parse of the same input.
package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"os"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/wtf8"
)

type record struct {
	ID    string          `json:"id"`
	Value json.RawMessage `json:"value"`
}

type answer struct {
	ID   string `json:"id"`
	Text string `json:"text"`
	OK   bool   `json:"ok"`
}

func main() {
	corpus := flag.String("corpus", "", "JSON-lines input")
	out := flag.String("out", "", "JSON-lines output")
	flag.Parse()
	if *corpus == "" || *out == "" {
		fmt.Fprintln(os.Stderr, "wtf8proof: -corpus and -out are required")
		os.Exit(2)
	}
	input, err := os.Open(*corpus)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer input.Close()
	output, err := os.Create(*out)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer output.Close()
	writer := bufio.NewWriter(output)
	defer writer.Flush()
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 0, 1<<20), 1<<22)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var entry record
		if err := json.Unmarshal(line, &entry); err != nil {
			fmt.Fprintln(os.Stderr, "bad corpus line:", err)
			os.Exit(1)
		}
		var value any
		if err := wtf8.Unmarshal(entry.Value, &value); err != nil {
			fmt.Fprintf(writer, `{"id":%q,"ok":false}`+"\n", entry.ID)
			continue
		}
		body, err := wtf8.Marshal(value)
		if err != nil {
			fmt.Fprintf(writer, `{"id":%q,"ok":false}`+"\n", entry.ID)
			continue
		}
		envelope := answer{ID: entry.ID, Text: string(body), OK: true}
		encoded, _ := json.Marshal(envelope)
		writer.Write(encoded)
		writer.WriteByte('\n')
	}
	if err := scanner.Err(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
