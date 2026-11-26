package threads

import (
	"bufio"
	"encoding/json"
	"os"
	"testing"
)

// TestPlainMarkdownTextMatchesTypeScript replays testdata/reply-excerpt-fuzz.jsonl, written by
// apps/api-go/tools/reply-excerpt-fuzz.mts from the real messageReplyPreview. Every string
// plainMarkdownText accepts must produce the preview text TypeScript produced; the rest are
// declined in production, so only their share is reported.
func TestPlainMarkdownTextMatchesTypeScript(t *testing.T) {
	file, err := os.Open("testdata/reply-excerpt-fuzz.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 1<<20), 1<<20)
	total, accepted, nonEmpty := 0, 0, 0
	for scanner.Scan() {
		var line struct {
			Text    string `json:"text"`
			Preview string `json:"preview"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &line); err != nil {
			t.Fatal(err)
		}
		total++
		if !plainMarkdownText(line.Text) {
			continue
		}
		accepted++
		blocks := []any{map[string]any{"kind": "text", "text": line.Text}}
		preview, plain := replyPreview(blocks, "bot", nil, nil)
		if !plain {
			t.Fatalf("%q: plain text declined", line.Text)
		}
		if line.Text != "" {
			nonEmpty++
		}
		if preview["text"] != line.Preview {
			t.Errorf("%q: Go preview %q, TypeScript %q", line.Text, preview["text"], line.Preview)
		}
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	t.Logf("corpus %d strings: %d accepted as plain (%d non-empty), %d left to TypeScript", total, accepted, nonEmpty, total-accepted)
	if total < 5000 || nonEmpty < 1500 {
		t.Fatalf("corpus too small to mean anything: %d strings, %d plain", total, nonEmpty)
	}
}

func TestPlainMarkdownTextRefusesMarkers(t *testing.T) {
	for _, text := range []string{
		"a*b", "a_b", "`a`", "[a]", "a(b)", "a<b", "a>b", "# a", "a~b", "a|b", "a!b", "a&b", "a:b",
		"a\nb", "a\tb", "a  b", " a", "a ", "- a", "+ a", "1. a", "a\\b", "😀", ".a",
	} {
		if plainMarkdownText(text) {
			t.Errorf("%q accepted as plain", text)
		}
	}
	for _, text := range []string{"", "hello world", "x 3.5 apples", "a-b", "x = y", "日本語"} {
		if !plainMarkdownText(text) {
			t.Errorf("%q refused", text)
		}
	}
}

// TestReplyPreviewNamesTheJobTitle covers a reply to a job card: the preview names the job, the
// same as TypeScript's `case "voice_call", "cloud_agent", "job", "page": return block.title`
// (packages/core/src/messages/message-quote.ts:171-175).
func TestReplyPreviewNamesTheJobTitle(t *testing.T) {
	cases := []struct {
		name  string
		block map[string]any
	}{
		{
			name:  "minimal legacy card",
			block: map[string]any{"kind": "job", "jobId": "job-1", "title": "mcp-job-card", "state": "working"},
		},
		{
			name: "rich coding card",
			block: map[string]any{
				"kind": "job", "jobId": "job-1", "title": "mcp-job-card", "agent": "pi",
				"branch": "Anxiety471/mcp-job-card", "state": "finished", "startedAt": 1_770_000_000_000,
				"reply": "Ported the job card.", "finishedAt": 1_770_000_060_000, "turn": 3,
				"repo": "Anxiety471/hivemind", "commit": "6a25fd26e384", "model": "gpt-5.5",
				"summary": "Adds the coding details to the job card.", "prLabel": "#812",
				"stats": map[string]any{"filesChanged": 4, "costUsd": 0.42},
				"files": []any{map[string]any{"path": "tool-card.ts", "status": "modified"}},
				"steps": []any{map[string]any{"kind": "tool", "name": "grep", "status": "ok"}},
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			preview, plain := replyPreview([]any{tc.block}, "bot", nil, nil)
			if !plain {
				t.Fatal("a job card's title needs no Markdown render")
			}
			if preview["text"] != tc.block["title"] {
				t.Fatalf("preview text = %v, want the title %v", preview["text"], tc.block["title"])
			}
			if preview["role"] != "bot" {
				t.Fatalf("preview role = %v", preview["role"])
			}
		})
	}
}
