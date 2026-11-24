package wtf8

import (
	"encoding/json"
	"fmt"
	"testing"
)

func surrogateFreeBody(count int) any {
	items := make([]any, count)
	for index := 0; index < count; index++ {
		items[index] = map[string]any{
			"id":    fmt.Sprintf("item-%d", index),
			"title": "A plain title with punctuation, 100% safe",
			"body":  "The quick brown fox jumps over the lazy dog.",
			"tags":  []any{"alpha", "beta"},
		}
	}
	return map[string]any{"json": map[string]any{"items": items, "next": "cursor-1"}}
}

func BenchmarkMarshalSurrogateFree(b *testing.B) {
	body := surrogateFreeBody(20_000)
	b.Run("encoding/json", func(b *testing.B) {
		b.ReportAllocs()
		for index := 0; index < b.N; index++ {
			if _, err := json.Marshal(body); err != nil {
				b.Fatal(err)
			}
		}
	})
	b.Run("wtf8", func(b *testing.B) {
		b.ReportAllocs()
		for index := 0; index < b.N; index++ {
			if _, err := Marshal(body); err != nil {
				b.Fatal(err)
			}
		}
	})
}

func BenchmarkUnmarshalSurrogateFree(b *testing.B) {
	raw, err := json.Marshal(surrogateFreeBody(20_000))
	if err != nil {
		b.Fatal(err)
	}
	b.Run("encoding/json", func(b *testing.B) {
		b.ReportAllocs()
		for index := 0; index < b.N; index++ {
			var value any
			if err := json.Unmarshal(raw, &value); err != nil {
				b.Fatal(err)
			}
		}
	})
	b.Run("wtf8", func(b *testing.B) {
		b.ReportAllocs()
		for index := 0; index < b.N; index++ {
			var value any
			if err := Unmarshal(raw, &value); err != nil {
				b.Fatal(err)
			}
		}
	})
}

func BenchmarkNeedsEncoding(b *testing.B) {
	body := surrogateFreeBody(20_000)
	b.ReportAllocs()
	for index := 0; index < b.N; index++ {
		if needsEncodingAny(body) {
			b.Fatal("unexpected encoding need")
		}
	}
}
