package messageblocks

import (
	"bytes"
	"encoding/json"
	"testing"
)

// The accept/reject pairs and the cleaned value below are what MessageBlock.safeParse answers on
// the TypeScript schema (packages/contracts/src/integrations/tool-card.ts:20-45, listed by
// packages/contracts/src/threads/message-blocks.ts:299) for the same input: they were produced by
// running the zod schema on this table, not written by hand.
func TestParseJobBlockMatchesZod(t *testing.T) {
	cases := map[string]struct {
		json string
		want bool
	}{
		"minimal":         {`{"kind":"job","jobId":"j1","title":"Fix the build","state":"working"}`, true},
		"full":            {`{"kind":"job","jobId":" j2 ","title":" Ship it ","agent":" Orca ","branch":" feat/x ","state":"finished","startedAt":0,"url":" https://example.test/jobs/2 ","reply":" done "}`, true},
		"state-starting":  {`{"kind":"job","jobId":"j","title":"t","state":"starting"}`, true},
		"state-finished":  {`{"kind":"job","jobId":"j","title":"t","state":"finished"}`, true},
		"state-needs":     {`{"kind":"job","jobId":"j","title":"t","state":"needs_input"}`, true},
		"state-exited":    {`{"kind":"job","jobId":"j","title":"t","state":"exited"}`, true},
		"state-timed-out": {`{"kind":"job","jobId":"j","title":"t","state":"timed_out"}`, true},
		// z.object strips what it does not name: the card never keeps a server or tool.
		"extra-keys-stripped":   {`{"kind":"job","jobId":"j","title":"t","state":"working","server":"github","tool":"run","replyTo":"x"}`, true},
		"extra-nested-value":    {`{"kind":"job","jobId":"j","title":"t","state":"working","extra":{"deep":[1,2]}}`, true},
		"url-trims-to-empty":    {`{"kind":"job","jobId":"j","title":"t","state":"working","url":"  "}`, true},
		"url-2048":              {`{"kind":"job","jobId":"j","title":"t","state":"working","url":"` + repeat("u", 2048) + `"}`, true},
		"url-not-https":         {`{"kind":"job","jobId":"j","title":"t","state":"working","url":"ftp://x"}`, true},
		"reply-4000":            {`{"kind":"job","jobId":"j","title":"t","state":"working","reply":"` + repeat("r", 4000) + `"}`, true},
		"title-emoji-200":       {`{"kind":"job","jobId":"j","title":"` + repeat("😀", 200) + `","state":"working"}`, true},
		"started-at-float-zero": {`{"kind":"job","jobId":"j","title":"t","state":"working","startedAt":0.0}`, true},
		"blank-title":           {`{"kind":"job","jobId":"j","title":"   ","state":"working"}`, false},
		"blank-job-id":          {`{"kind":"job","jobId":" ","title":"t","state":"working"}`, false},
		"title-201":             {`{"kind":"job","jobId":"j","title":"` + repeat("x", 201) + `","state":"working"}`, false},
		"title-emoji-201":       {`{"kind":"job","jobId":"j","title":"` + repeat("😀", 201) + `","state":"working"}`, false},
		"agent-81":              {`{"kind":"job","jobId":"j","title":"t","state":"working","agent":"` + repeat("a", 81) + `"}`, false},
		"branch-241":            {`{"kind":"job","jobId":"j","title":"t","state":"working","branch":"` + repeat("b", 241) + `"}`, false},
		"url-2049":              {`{"kind":"job","jobId":"j","title":"t","state":"working","url":"` + repeat("u", 2049) + `"}`, false},
		"reply-4001":            {`{"kind":"job","jobId":"j","title":"t","state":"working","reply":"` + repeat("r", 4001) + `"}`, false},
		"agent-null":            {`{"kind":"job","jobId":"j","title":"t","state":"working","agent":null}`, false},
		"reply-null":            {`{"kind":"job","jobId":"j","title":"t","state":"working","reply":null}`, false},
		"started-negative":      {`{"kind":"job","jobId":"j","title":"t","state":"working","startedAt":-1}`, false},
		"started-fraction":      {`{"kind":"job","jobId":"j","title":"t","state":"working","startedAt":1.5}`, false},
		"state-unknown":         {`{"kind":"job","jobId":"j","title":"t","state":"running"}`, false},
		"missing-state":         {`{"kind":"job","jobId":"j","title":"t"}`, false},
		"missing-title":         {`{"kind":"job","jobId":"j","state":"working"}`, false},
		"job-id-number":         {`{"kind":"job","jobId":7,"title":"t","state":"working"}`, false},
	}
	for name, test := range cases {
		t.Run(name, func(t *testing.T) {
			entries := decodeOneBlock(t, test.json)
			_, valid := ParseBlocks(entries)
			if valid != test.want {
				t.Fatalf("ParseBlocks valid = %v, want %v (zod fixture)", valid, test.want)
			}
		})
	}
}

// TestParseJobBlockCleansLikeZod pins the parsed value, not just whether it parses: strings are
// trimmed, unknown keys are gone, and an absent optional is absent rather than null.
func TestParseJobBlockCleansLikeZod(t *testing.T) {
	cases := map[string]struct{ in, want string }{
		"full": {
			`{"kind":"job","jobId":" j2 ","title":" Ship it ","agent":" Orca ","branch":" feat/x ","state":"finished","startedAt":0,"url":" https://example.test/jobs/2 ","reply":" done "}`,
			`{"agent":"Orca","branch":"feat/x","jobId":"j2","kind":"job","reply":"done","startedAt":0,"state":"finished","title":"Ship it","url":"https://example.test/jobs/2"}`,
		},
		"extra-keys": {
			`{"kind":"job","jobId":"j","title":"t","state":"working","server":"github","tool":"run"}`,
			`{"jobId":"j","kind":"job","state":"working","title":"t"}`,
		},
		"url-trims-to-empty": {
			`{"kind":"job","jobId":"j","title":"t","state":"working","url":"  "}`,
			`{"jobId":"j","kind":"job","state":"working","title":"t","url":""}`,
		},
	}
	for name, test := range cases {
		t.Run(name, func(t *testing.T) {
			cleaned, valid := ParseBlocks(decodeOneBlock(t, test.in))
			if !valid {
				t.Fatal("expected the job card to parse")
			}
			body, err := json.Marshal(cleaned[0])
			if err != nil {
				t.Fatal(err)
			}
			if string(body) != test.want {
				t.Fatalf("cleaned block = %s, want %s", body, test.want)
			}
		})
	}
}

// decodeOneBlock decodes one fixture into the list ParseBlocks takes, with numbers kept as the
// json.Number form a jsonb read produces.
func decodeOneBlock(t *testing.T, raw string) []any {
	t.Helper()
	decoder := json.NewDecoder(bytes.NewReader([]byte(raw)))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		t.Fatalf("decode %s: %v", raw, err)
	}
	return []any{value}
}

func repeat(text string, count int) string {
	out := make([]byte, 0, len(text)*count)
	for range count {
		out = append(out, text...)
	}
	return string(out)
}
