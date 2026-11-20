package routines

import (
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

// JavaScript counts and slices strings in UTF-16 code units, while Go counts runes. The two
// differ for anything outside the BMP; an emoji is one rune and two units.

// sliceUnits is String.prototype.slice(0, limit): the first limit UTF-16 code units and the
// string's full length in units. A cut that splits a surrogate pair leaves the high half
// alone, which no Go string can hold, so the returned units are quoted by quoteUnits.
func sliceUnits(text string, limit int) ([]uint16, int) {
	units := utf16.Encode([]rune(text))
	if len(units) <= limit {
		return units, len(units)
	}
	// The cut may land between the halves of a surrogate pair, exactly as JavaScript's does.
	return units[:limit], len(units)
}

// unitsOf is a string as UTF-16 code units.
func unitsOf(text string) []uint16 { return utf16.Encode([]rune(text)) }

// quoteUnits is JSON.stringify of a string read as UTF-16 code units. Well-formed pairs are
// written as the character; an unpaired surrogate is written as a lower-case \udXXX escape,
// as JSON.stringify writes it, so a truncation that split a pair still answers what
// TypeScript answers.
func quoteUnits(units []uint16) []byte {
	const hex = "0123456789abcdef"
	var out strings.Builder
	out.WriteByte('"')
	for index := 0; index < len(units); index++ {
		unit := units[index]
		switch {
		case unit == '"':
			out.WriteString(`\"`)
		case unit == '\\':
			out.WriteString(`\\`)
		case unit == '\b':
			out.WriteString(`\b`)
		case unit == '\f':
			out.WriteString(`\f`)
		case unit == '\n':
			out.WriteString(`\n`)
		case unit == '\r':
			out.WriteString(`\r`)
		case unit == '\t':
			out.WriteString(`\t`)
		case unit < 0x20:
			out.WriteString(`\u00`)
			out.WriteByte(hex[unit>>4])
			out.WriteByte(hex[unit&0xf])
		case unit >= 0xd800 && unit <= 0xdbff && index+1 < len(units) && units[index+1] >= 0xdc00 && units[index+1] <= 0xdfff:
			out.WriteRune(utf16.DecodeRune(rune(unit), rune(units[index+1])))
			index++
		case unit >= 0xd800 && unit <= 0xdfff:
			out.WriteString(`\u` + strconv.FormatUint(uint64(unit), 16))
		default:
			out.WriteRune(rune(unit))
		}
	}
	out.WriteByte('"')
	return []byte(out.String())
}

// quoteText is quoteUnits for a string read as runes.
func quoteText(text string) []byte { return quoteUnits(unitsOf(text)) }

// runeCount is zod's string length check, which counts code points.
func runeCount(text string) int { return utf8.RuneCountInString(text) }
