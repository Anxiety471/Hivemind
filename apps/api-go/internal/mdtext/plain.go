// Package mdtext ports packages/core/src/messages/markdown-plain.ts: Markdown
// source to the single plain line the app shows in sidebar previews and
// notifications.
//
// The TypeScript is not a CommonMark renderer. It is a hand-rolled extractor
// that walks UTF-16 code units (String.prototype.length, slice, charCodeAt,
// global regexes without the `u` flag), stashes literals behind one-char
// payload tokens, and collapses whitespace at the end. Byte parity therefore
// needs the same unit indices, so the core works on []uint16 and only the
// string wrappers convert at the edge. See tools/mdtext-diff.mts for the
// differential harness that pins it to the TypeScript.
package mdtext

import (
	"strconv"
	"strings"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"
)

// maxPreviewSource is MAX_PREVIEW_SOURCE (markdown-plain.ts:7): a preview
// collapses to one line, and Android walks replies one at a time.
const maxPreviewSource = 4096

// MaxPreviewSource is the default source cap.
const MaxPreviewSource = maxPreviewSource

// payloadMark is PAYLOAD_MARK (markdown-plain.ts:1).
const payloadMark = 0xE000

// Units converts a Go string to UTF-16 code units, as JavaScript holds it.
func Units(text string) []uint16 {
	units := make([]uint16, 0, len(text))
	for _, character := range text {
		units = utf16.AppendRune(units, character)
	}
	return units
}

// String converts UTF-16 code units to a Go string. An unpaired surrogate has
// no UTF-8 form and becomes U+FFFD, as a Go string always holds; the
// differential harness compares code units instead.
func String(units []uint16) string {
	if len(units) == 0 {
		return ""
	}
	var out strings.Builder
	out.Grow(len(units))
	for index := 0; index < len(units); index++ {
		unit := units[index]
		if unit >= 0xD800 && unit <= 0xDBFF && index+1 < len(units) &&
			units[index+1] >= 0xDC00 && units[index+1] <= 0xDFFF {
			out.WriteRune(utf16.DecodeRune(rune(unit), rune(units[index+1])))
			index++
			continue
		}
		if unit >= 0xD800 && unit <= 0xDFFF {
			out.WriteRune(utf8.RuneError)
			continue
		}
		out.WriteRune(rune(unit))
	}
	return out.String()
}

// PlainTextFromMarkdown is plainTextFromMarkdown with its default source cap.
func PlainTextFromMarkdown(markdown string) string {
	return String(PlainTextFromMarkdownUnits(Units(markdown), maxPreviewSource))
}

// PlainTextFromMarkdownCapped is plainTextFromMarkdown(markdown, {maxSource}).
func PlainTextFromMarkdownCapped(markdown string, maxSource int) string {
	return String(PlainTextFromMarkdownUnits(Units(markdown), maxSource))
}

// PlainTextFromMarkdownUnits is the core, over UTF-16 code units.
func PlainTextFromMarkdownUnits(source []uint16, maxSource int) []uint16 {
	stash := newStasher()
	text, truncated := boundedPreviewSource(source, maxSource)
	text = replaceAll(text, payloadMark, stash.markToken())
	text = takeFencedCode(text, stash, truncated)
	text = takeInlineCode(text, stash)
	text = takeEscapes(text, stash)
	// Autolinks may contain stashed escapes; flatten only those literal payloads.
	text = replaceAutolinks(takeLinks(text), stash)
	text = stripUnderscoreEmphasis(stripHTMLTags(text))
	// Table rows keep only their cells; a separator row is pure syntax.
	// flattenTableRows also strips heading/list/quote/break markers per line so
	// it can see them: a marked line interrupts the table instead of becoming a
	// phantom row, while its stripped text still previews. Runs before the
	// emphasis strips so "| **a** |" still reads "a".
	text = flattenTableRows(text)
	text = replaceDoubleStar(text)
	text = replaceSingleStar(text)
	text = replaceDoubleTilde(text)
	return trimJS(collapseSpace(stash.restore(text)))
}

// stasher is the payload table (markdown-plain.ts:22-36). Payload text never
// carries a raw mark: one could sit next to digits and impersonate a token on
// restore (a payload could even refer to itself and recurse forever). Marks are
// rewritten as payload-0 tokens instead, and restored payload text is never
// rescanned, so the recursion is bounded by the payload count.
type stasher struct {
	payloads [][]uint16
}

func newStasher() *stasher {
	return &stasher{payloads: [][]uint16{{payloadMark}}}
}

// markToken is `${PAYLOAD_MARK}0${PAYLOAD_MARK}`.
func (s *stasher) markToken() []uint16 {
	return []uint16{payloadMark, '0', payloadMark}
}

func token(index int) []uint16 {
	digits := strconv.Itoa(index)
	out := make([]uint16, 0, len(digits)+2)
	out = append(out, payloadMark)
	for index := range len(digits) {
		out = append(out, uint16(digits[index]))
	}
	return append(out, payloadMark)
}

func (s *stasher) stash(payload []uint16) []uint16 {
	marked := make([]uint16, 0, len(payload))
	for _, unit := range payload {
		if unit == payloadMark {
			marked = append(marked, s.markToken()...)
			continue
		}
		marked = append(marked, unit)
	}
	s.payloads = append(s.payloads, marked)
	return token(len(s.payloads) - 1)
}

// restore is /\uE000(\d+)\uE000/g replaced recursively, with an out-of-range
// index restoring as "".
func (s *stasher) restore(text []uint16) []uint16 {
	out := make([]uint16, 0, len(text))
	for index := 0; index < len(text); {
		if text[index] != payloadMark {
			out = append(out, text[index])
			index++
			continue
		}
		end := index + 1
		for end < len(text) && text[end] >= '0' && text[end] <= '9' {
			end++
		}
		if end == index+1 || end >= len(text) || text[end] != payloadMark {
			out = append(out, text[index])
			index++
			continue
		}
		value, overflow := 0, false
		for _, digit := range text[index+1 : end] {
			if value > 1<<24 {
				overflow = true
				break
			}
			value = value*10 + int(digit-'0')
		}
		if !overflow && value < len(s.payloads) {
			out = append(out, s.restore(s.payloads[value])...)
		}
		index = end + 1
	}
	return out
}

// boundedPreviewSource is boundedPreviewSource (markdown-plain.ts:300): past
// the cap, leading whitespace is skipped first, otherwise a pad of spaces
// consumes the window and the body vanishes.
func boundedPreviewSource(markdown []uint16, maxSource int) ([]uint16, bool) {
	normalized := replaceLineEndings(markdown)
	if len(normalized) <= maxSource {
		return normalized, false
	}
	body := trimStartJS(normalized)
	if len(body) <= maxSource {
		return body, false
	}
	return truncateUnits(body, maxSource), true
}

// replaceLineEndings is /\r\n?/g → "\n".
func replaceLineEndings(text []uint16) []uint16 {
	out := make([]uint16, 0, len(text))
	for index := 0; index < len(text); index++ {
		if text[index] != '\r' {
			out = append(out, text[index])
			continue
		}
		if index+1 < len(text) && text[index+1] == '\n' {
			index++
		}
		out = append(out, '\n')
	}
	return out
}

// replaceAll replaces every occurrence of a fixed code unit.
func replaceAll(text []uint16, from uint16, to []uint16) []uint16 {
	out := make([]uint16, 0, len(text))
	for _, unit := range text {
		if unit == from {
			out = append(out, to...)
			continue
		}
		out = append(out, unit)
	}
	return out
}

// isJSSpace is \s: the ECMAScript WhiteSpace and LineTerminator set.
func isJSSpace(unit uint16) bool {
	switch unit {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
		return true
	}
	return unit >= 0x2000 && unit <= 0x200A
}

// isLineTerminator is what a `.` in a JavaScript regex will not match.
func isLineTerminator(unit uint16) bool {
	return unit == '\n' || unit == '\r' || unit == 0x2028 || unit == 0x2029
}

func trimJS(text []uint16) []uint16 {
	start, end := 0, len(text)
	for start < end && isJSSpace(text[start]) {
		start++
	}
	for end > start && isJSSpace(text[end-1]) {
		end--
	}
	return text[start:end]
}

func trimStartJS(text []uint16) []uint16 {
	start := 0
	for start < len(text) && isJSSpace(text[start]) {
		start++
	}
	return text[start:]
}

// collapseSpace is /\s+/g → " ".
func collapseSpace(text []uint16) []uint16 {
	out := make([]uint16, 0, len(text))
	inSpace := false
	for _, unit := range text {
		if isJSSpace(unit) {
			if !inSpace {
				out = append(out, ' ')
				inSpace = true
			}
			continue
		}
		inSpace = false
		out = append(out, unit)
	}
	return out
}

func startsWith(text []uint16, at int, prefix string) bool {
	if at < 0 || at+len(prefix) > len(text) {
		return false
	}
	for index := range len(prefix) {
		if text[at+index] != uint16(prefix[index]) {
			return false
		}
	}
	return true
}

func indexFrom(text []uint16, from int, needle string) int {
	for index := from; index+len(needle) <= len(text); index++ {
		if startsWith(text, index, needle) {
			return index
		}
	}
	return -1
}

// matchTableRow is TABLE_ROW: /^\s*\|(.+)\|\s*$/.
func matchTableRow(line []uint16) bool {
	start := 0
	for start < len(line) && isJSSpace(line[start]) {
		start++
	}
	if start >= len(line) || line[start] != '|' {
		return false
	}
	end := len(line)
	for end > start && isJSSpace(line[end-1]) {
		end--
	}
	if end-start < 3 || line[end-1] != '|' {
		return false
	}
	for index := start + 1; index < end-1; index++ {
		if isLineTerminator(line[index]) {
			return false
		}
	}
	return true
}

// isTableSeparatorLine is isTableSeparator (markdown-plain.ts:65): every GFM
// delimiter cell needs at least one hyphen; `| : |` is content.
func isTableSeparatorLine(line []uint16) bool {
	trimmed := trimJS(line)
	found := false
	for _, unit := range trimmed {
		if unit == '-' {
			found = true
			break
		}
	}
	if !found {
		return false
	}
	rest := trimmed
	if len(rest) > 0 && rest[0] == '|' {
		rest = rest[1:]
	}
	if len(rest) > 0 && rest[len(rest)-1] == '|' {
		rest = rest[:len(rest)-1]
	}
	for _, cell := range split(rest, '|') {
		if !isDelimiterCell(trimJS(cell)) {
			return false
		}
	}
	return true
}

// isDelimiterCell is /^:?-+:?$/ on the trimmed cell.
func isDelimiterCell(cell []uint16) bool {
	index := 0
	if index < len(cell) && cell[index] == ':' {
		index++
	}
	hyphens := 0
	for index < len(cell) && cell[index] == '-' {
		hyphens++
		index++
	}
	if hyphens == 0 {
		return false
	}
	if index < len(cell) && cell[index] == ':' {
		index++
	}
	return index == len(cell)
}

// split is String.prototype.split with a one-code-unit separator.
func split(text []uint16, separator uint16) [][]uint16 {
	parts := [][]uint16{}
	from := 0
	for index := 0; index < len(text); index++ {
		if text[index] != separator {
			continue
		}
		parts = append(parts, text[from:index])
		from = index + 1
	}
	return append(parts, text[from:])
}

// stripLineMarker is stripLineMarker (markdown-plain.ts:77): heading, quote,
// list and break markers; the line's own text survives.
func stripLineMarker(line []uint16) []uint16 {
	stripped := stripHeadingMarker(line)
	stripped = stripQuoteMarker(stripped)
	stripped = stripBulletMarker(stripped)
	stripped = stripOrderedMarker(stripped)
	if isHorizontalRule(stripped) {
		return []uint16{}
	}
	return stripped
}

// stripHeadingMarker is /^\s{0,3}#{1,6}\s+/.
func stripHeadingMarker(line []uint16) []uint16 {
	spaces := 0
	for spaces < len(line) && isJSSpace(line[spaces]) {
		spaces++
	}
	if spaces > 3 {
		return line
	}
	index := spaces
	hashes := 0
	for index < len(line) && line[index] == '#' {
		hashes++
		index++
	}
	if hashes == 0 || hashes > 6 || index >= len(line) || !isJSSpace(line[index]) {
		return line
	}
	for index < len(line) && isJSSpace(line[index]) {
		index++
	}
	return line[index:]
}

// stripQuoteMarker is /^\s*>\s?/.
func stripQuoteMarker(line []uint16) []uint16 {
	index := 0
	for index < len(line) && isJSSpace(line[index]) {
		index++
	}
	if index >= len(line) || line[index] != '>' {
		return line
	}
	index++
	if index < len(line) && isJSSpace(line[index]) {
		index++
	}
	return line[index:]
}

// stripBulletMarker is /^\s*[-*+]\s+/.
func stripBulletMarker(line []uint16) []uint16 {
	index := 0
	for index < len(line) && isJSSpace(line[index]) {
		index++
	}
	if index >= len(line) {
		return line
	}
	switch line[index] {
	case '-', '*', '+':
	default:
		return line
	}
	index++
	if index >= len(line) || !isJSSpace(line[index]) {
		return line
	}
	for index < len(line) && isJSSpace(line[index]) {
		index++
	}
	return line[index:]
}

// stripOrderedMarker is /^\s*\d+[.)]\s+/.
func stripOrderedMarker(line []uint16) []uint16 {
	index := 0
	for index < len(line) && isJSSpace(line[index]) {
		index++
	}
	digits := 0
	for index < len(line) && line[index] >= '0' && line[index] <= '9' {
		digits++
		index++
	}
	if digits == 0 || index >= len(line) || (line[index] != '.' && line[index] != ')') {
		return line
	}
	index++
	if index >= len(line) || !isJSSpace(line[index]) {
		return line
	}
	for index < len(line) && isJSSpace(line[index]) {
		index++
	}
	return line[index:]
}

// isHorizontalRule is /^\s*[-*_]{3,}\s*$/.
func isHorizontalRule(line []uint16) bool {
	index := 0
	for index < len(line) && isJSSpace(line[index]) {
		index++
	}
	markers := 0
	for index < len(line) {
		switch line[index] {
		case '-', '*', '_':
			markers++
			index++
			continue
		}
		break
	}
	if markers < 3 {
		return false
	}
	for ; index < len(line); index++ {
		if !isJSSpace(line[index]) {
			return false
		}
	}
	return true
}

// tableCells is tableCells (markdown-plain.ts:87): row text → "a, b"; edge
// pipes only produce empty ends, which drop out.
func tableCells(line []uint16) []uint16 {
	out := []uint16{}
	first := true
	for _, cell := range split(line, '|') {
		trimmed := trimJS(cell)
		if len(trimmed) == 0 {
			continue
		}
		if !first {
			out = append(out, ',', ' ')
		}
		first = false
		out = append(out, trimmed...)
	}
	return out
}

// flattenTableRows is flattenTableRows (markdown-plain.ts:106).
func flattenTableRows(text []uint16) []uint16 {
	lines := split(text, '\n')
	out := make([][]uint16, 0, len(lines))
	inTable := false
	prevHadPipe := false
	prevFlattened := false
	for _, rawLine := range lines {
		line := stripLineMarker(rawLine)
		if !equalUnits(line, rawLine) {
			inTable = false
			prevHadPipe = false
			prevFlattened = false
			// A separator row stays syntax even behind a quote or list marker.
			if !isTableSeparatorLine(line) {
				if matchTableRow(line) {
					out = append(out, tableCells(line))
				} else {
					out = append(out, line)
				}
			}
			continue
		}
		if !containsUnit(line, '|') {
			inTable = false
			prevHadPipe = false
			prevFlattened = false
			out = append(out, line)
			continue
		}
		if inTable {
			out = append(out, tableCells(line))
			prevHadPipe = true
			prevFlattened = true
			continue
		}
		if isTableSeparatorLine(line) {
			if prevHadPipe {
				inTable = true
				// A header written without outer pipes was emitted raw; flatten it now.
				if !prevFlattened && len(out) > 0 {
					out[len(out)-1] = tableCells(out[len(out)-1])
				}
			}
			continue
		}
		if matchTableRow(line) {
			out = append(out, tableCells(line))
			prevFlattened = true
		} else {
			out = append(out, line)
			prevFlattened = false
		}
		prevHadPipe = true
	}
	return join(out, '\n')
}

func equalUnits(left, right []uint16) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func containsUnit(text []uint16, unit uint16) bool {
	for _, candidate := range text {
		if candidate == unit {
			return true
		}
	}
	return false
}

func join(parts [][]uint16, separator uint16) []uint16 {
	size := 0
	for _, part := range parts {
		size += len(part)
	}
	if len(parts) > 1 {
		size += len(parts) - 1
	}
	out := make([]uint16, 0, size)
	for index, part := range parts {
		if index > 0 {
			out = append(out, separator)
		}
		out = append(out, part...)
	}
	return out
}

// delimiter is one `_` run of stripUnderscoreEmphasis.
type delimiter struct {
	start   int
	end     int
	removed int
}

// stripUnderscoreEmphasis is stripUnderscoreEmphasis (markdown-plain.ts:157):
// pair delimiter runs once, without rescanning unmatched suffixes.
func stripUnderscoreEmphasis(text []uint16) []uint16 {
	delimiters := []delimiter{}
	openers := []int{}
	previousEnd := 0
	for index := 0; index < len(text); {
		if text[index] != '_' {
			index++
			continue
		}
		start := index
		for index < len(text) && text[index] == '_' {
			index++
		}
		end := index
		for scan := previousEnd; scan < start; scan++ {
			if text[scan] == '\n' {
				openers = openers[:0]
				break
			}
		}
		previousEnd = end
		delimiters = append(delimiters, delimiter{start: start, end: end})
		// Two UTF-16 units preserve astral letters when checking each adjacent code point.
		before := text[max(0, start-2):start]
		after := text[end:min(len(text), end+2)]
		canClose := !startsWithLetterNumberMark(after) && endsWithNonSpace(before)
		remaining := end - start
		for canClose && remaining > 0 && len(openers) > 0 {
			opener := &delimiters[openers[len(openers)-1]]
			available := opener.end - opener.start - opener.removed
			paired := min(available, remaining)
			opener.removed += paired
			delimiters[len(delimiters)-1].removed += paired
			remaining -= paired
			if paired == available {
				openers = openers[:len(openers)-1]
			}
		}
		if remaining > 0 && !endsWithLetterNumberMark(before) && startsWithNonSpace(after) {
			openers = append(openers, len(delimiters)-1)
		}
	}
	parts := [][]uint16{}
	from := 0
	for _, item := range delimiters {
		if item.removed == 0 {
			continue
		}
		parts = append(parts, text[from:item.start])
		parts = append(parts, repeated('_', item.end-item.start-item.removed))
		from = item.end
	}
	parts = append(parts, text[from:])
	return concat(parts)
}

// concat is parts.join("").
func concat(parts [][]uint16) []uint16 {
	size := 0
	for _, part := range parts {
		size += len(part)
	}
	out := make([]uint16, 0, size)
	for _, part := range parts {
		out = append(out, part...)
	}
	return out
}

func repeated(unit uint16, count int) []uint16 {
	out := make([]uint16, count)
	for index := range out {
		out[index] = unit
	}
	return out
}

// firstCodePoint is the code point starting at the first unit of a window, as
// a `/u` regex sees it.
func firstCodePoint(window []uint16) (rune, bool) {
	if len(window) == 0 {
		return 0, false
	}
	if window[0] >= 0xD800 && window[0] <= 0xDBFF && len(window) > 1 &&
		window[1] >= 0xDC00 && window[1] <= 0xDFFF {
		return utf16.DecodeRune(rune(window[0]), rune(window[1])), true
	}
	return rune(window[0]), true
}

// lastCodePoint is the code point ending at the last unit of a window.
func lastCodePoint(window []uint16) (rune, bool) {
	if len(window) == 0 {
		return 0, false
	}
	last := len(window) - 1
	if window[last] >= 0xDC00 && window[last] <= 0xDFFF && last > 0 &&
		window[last-1] >= 0xD800 && window[last-1] <= 0xDBFF {
		return utf16.DecodeRune(rune(window[last-1]), rune(window[last])), true
	}
	return rune(window[last]), true
}

// isLetterNumberMark is \p{L}, \p{N} or \p{M}.
func isLetterNumberMark(character rune) bool {
	return unicode.IsLetter(character) || unicode.IsNumber(character) || unicode.IsMark(character)
}

func startsWithLetterNumberMark(window []uint16) bool {
	character, ok := firstCodePoint(window)
	return ok && isLetterNumberMark(character)
}

func endsWithLetterNumberMark(window []uint16) bool {
	character, ok := lastCodePoint(window)
	return ok && isLetterNumberMark(character)
}

// endsWithNonSpace is /\S$/u.
func endsWithNonSpace(window []uint16) bool {
	character, ok := lastCodePoint(window)
	return ok && !isJSSpaceCharacter(character)
}

// startsWithNonSpace is /^\S/u.
func startsWithNonSpace(window []uint16) bool {
	character, ok := firstCodePoint(window)
	return ok && !isJSSpaceCharacter(character)
}

// isJSSpaceCharacter is \s for a code point (the set holds no astral code point).
func isJSSpaceCharacter(character rune) bool {
	return character >= 0 && character <= 0xFFFF && isJSSpace(uint16(character))
}

// textBoundary is textBoundary (markdown-plain.ts:208): keep UTF-16 offsets
// while avoiding cuts inside a surrogate pair.
func TextBoundary(text []uint16, offset int) int {
	before := unitAt(text, offset-1)
	after := unitAt(text, offset)
	if before >= 0xD800 && before <= 0xDBFF && after >= 0xDC00 && after <= 0xDFFF {
		return offset - 1
	}
	return offset
}

// unitAt is charCodeAt: an out-of-range index reads as -1, which no comparison
// against a surrogate range accepts.
func unitAt(text []uint16, index int) int {
	if index < 0 || index >= len(text) {
		return -1
	}
	return int(text[index])
}

// ShortenedTextLength is shortenedTextLength (markdown-plain.ts:217).
func ShortenedTextLength(text []uint16) int {
	half := TextBoundary(text, len(text)/2)
	// When the first character is a surrogate pair, retain it if there is more text.
	if half != 0 {
		return half
	}
	if len(text) > 2 {
		return 2
	}
	return 0
}

func truncateUnits(text []uint16, maxChars int) []uint16 {
	if len(text) <= maxChars {
		return text
	}
	if maxChars < 0 {
		// slice(0, maxChars) with a negative end counts from the tail, and textBoundary got the
		// negative offset (charCodeAt out of range is NaN, so it changed nothing): the cut may
		// split a surrogate pair.
		end := len(text) + maxChars
		if end < 0 {
			end = 0
		}
		return text[:end]
	}
	return text[:TextBoundary(text, maxChars)]
}

// TruncatePlainText is truncatePlainText (markdown-plain.ts:224): shorten plain
// text without splitting a surrogate pair.
func TruncatePlainText(text string, maxChars int) string {
	return String(TruncatePlainTextUnits(Units(text), maxChars))
}

// TruncatePlainTextUnits is TruncatePlainText over UTF-16 code units.
func TruncatePlainTextUnits(text []uint16, maxChars int) []uint16 {
	return truncateUnits(text, maxChars)
}

// TruncatedPlainText is truncatedPlainText (markdown-plain.ts:203): strip
// Markdown first so truncation cannot land inside a marker.
func TruncatedPlainText(markdown string, maxChars int) string {
	return String(TruncatedPlainTextUnits(Units(markdown), maxChars))
}

// TruncatedPlainTextUnits is TruncatedPlainText over UTF-16 code units.
func TruncatedPlainTextUnits(markdown []uint16, maxChars int) []uint16 {
	return truncateUnits(PlainTextFromMarkdownUnits(markdown, maxPreviewSource), maxChars)
}

// htmlTagClose is htmlTagClose (markdown-plain.ts:230): matching `>` for a tag
// at `<`, ignoring `>` inside quoted attributes.
func htmlTagClose(text []uint16, open int) int {
	if startsWith(text, open, "<!--") {
		close := indexFrom(text, open+4, "-->")
		if close == -1 {
			return len(text) - 1
		}
		return close + 2
	}
	var quote uint16
	gtInOpenQuote := -1
	for index := open + 1; index < len(text); index++ {
		character := text[index]
		if quote != 0 {
			if character == quote {
				quote = 0
				gtInOpenQuote = -1
				continue
			}
			if character == '>' && gtInOpenQuote == -1 {
				gtInOpenQuote = index
			}
			continue
		}
		if character == '"' || character == '\'' {
			quote = character
			continue
		}
		if character == '>' {
			return index
		}
	}
	if gtInOpenQuote != -1 {
		return gtInOpenQuote
	}
	// Unclosed quote with no `>`: consume the rest so attribute text cannot leak.
	if quote != 0 && len(text) > open+1 {
		return len(text) - 1
	}
	return -1
}

func isASCIIAlpha(unit uint16) bool {
	return (unit >= 'a' && unit <= 'z') || (unit >= 'A' && unit <= 'Z')
}

func isASCIIAlnumHyphen(unit uint16) bool {
	return isASCIIAlpha(unit) || (unit >= '0' && unit <= '9') || unit == '-'
}

// isAttributeNameStart is [A-Za-z_:@].
func isAttributeNameStart(unit uint16) bool {
	return isASCIIAlpha(unit) || unit == '_' || unit == ':' || unit == '@'
}

// isAttributeChar is [^\s"'<>/=&].
func isAttributeChar(unit uint16) bool {
	switch unit {
	case '"', '\'', '<', '>', '/', '=', '&':
		return false
	}
	return !isJSSpace(unit)
}

// isHTMLTagStart is isHtmlTagStart (markdown-plain.ts:264) for the sticky
// HTML_TAG_START pattern: a tag opens with `!`, `?`, or a name of letters,
// digits and hyphens followed by whitespace, `/` or `>` and then
// attribute-like content; `a<b+1` and `y && z` are prose.
func isHTMLTagStart(text []uint16, at int) bool {
	index := at + 1
	if index >= len(text) {
		return false
	}
	if text[index] == '!' || text[index] == '?' {
		return true
	}
	if text[index] == '/' {
		index++
	}
	if index >= len(text) || !isASCIIAlpha(text[index]) {
		return false
	}
	index++
	for index < len(text) && isASCIIAlnumHyphen(text[index]) {
		index++
	}
	if index < len(text) && (text[index] == '/' || text[index] == '>') {
		return true
	}
	if index >= len(text) || !isJSSpace(text[index]) {
		return false
	}
	for index < len(text) && isJSSpace(text[index]) {
		index++
	}
	if index >= len(text) {
		return false
	}
	if text[index] == '/' || text[index] == '>' {
		return true
	}
	if !isAttributeNameStart(text[index]) {
		return false
	}
	index++
	for index < len(text) && isAttributeChar(text[index]) {
		index++
	}
	if index >= len(text) {
		return true
	}
	return isJSSpace(text[index]) || text[index] == '=' || text[index] == '/' || text[index] == '>'
}

// stripHTMLTags is stripHTMLTags (markdown-plain.ts:269).
func stripHTMLTags(text []uint16) []uint16 {
	out := make([]uint16, 0, len(text))
	for index := 0; index < len(text); {
		if text[index] == '<' && isHTMLTagStart(text, index) {
			if close := htmlTagClose(text, index); close != -1 {
				out = append(out, ' ')
				index = close + 1
				continue
			}
		}
		out = append(out, text[index])
		index++
	}
	return out
}

// isEscapablePunctuation is the character class of takeEscapes' pattern.
func isEscapablePunctuation(unit uint16) bool {
	switch unit {
	case '!', '"', '#', '$', '%', '&', '\'', '(', ')', '*', '+', ',', '-', '.', '/', ':',
		';', '<', '=', '>', '?', '@', '[', '\\', ']', '^', '_', '`', '{', '|', '}', '~':
		return true
	}
	return false
}

// takeEscapes is takeEscapes (markdown-plain.ts:287).
func takeEscapes(text []uint16, stash *stasher) []uint16 {
	out := make([]uint16, 0, len(text))
	for index := 0; index < len(text); {
		if text[index] == '\\' && index+1 < len(text) && isEscapablePunctuation(text[index+1]) {
			out = append(out, stash.stash([]uint16{text[index+1]})...)
			index += 2
			continue
		}
		out = append(out, text[index])
		index++
	}
	return out
}

// fence is one OPEN_FENCE match.
type fence struct {
	marker []uint16
	info   []uint16
}

// matchOpenFence is OPEN_FENCE: /^ {0,3}(`{3,}|~{3,})(.*)$/.
func matchOpenFence(line []uint16) (fence, bool) {
	index := 0
	for index < 3 && index < len(line) && line[index] == ' ' {
		index++
	}
	if index < len(line) && line[index] == ' ' {
		return fence{}, false
	}
	if index >= len(line) || (line[index] != '`' && line[index] != '~') {
		return fence{}, false
	}
	character := line[index]
	start := index
	for index < len(line) && line[index] == character {
		index++
	}
	if index-start < 3 {
		return fence{}, false
	}
	// (.*)$ with `.` excluding line terminators and `$` at the very end.
	for scan := index; scan < len(line); scan++ {
		if isLineTerminator(line[scan]) {
			return fence{}, false
		}
	}
	return fence{marker: line[start:index], info: line[index:]}, true
}

// takeFencedCode is takeFencedCode (markdown-plain.ts:311).
func takeFencedCode(text []uint16, stash *stasher, truncated bool) []uint16 {
	lines := split(text, '\n')
	out := [][]uint16{}
	for index := 0; index < len(lines); index++ {
		line := lines[index]
		open, matched := matchOpenFence(line)
		if !matched {
			out = append(out, line)
			continue
		}
		fenceChar := open.marker[0]
		if fenceChar == '`' && containsUnit(open.info, '`') {
			out = append(out, line)
			continue
		}
		body := [][]uint16{}
		closed := false
		// Blank-info fence lines are the only closers. If this scan sees none,
		// no later opener can close either, so the tail is not scanned again.
		sawCloser := false
		next := index + 1
		for ; next < len(lines); next++ {
			close, closeMatched := matchOpenFence(lines[next])
			if closeMatched && len(trimJS(close.info)) == 0 {
				sawCloser = true
				if close.marker[0] == fenceChar && len(close.marker) >= len(open.marker) {
					closed = true
					break
				}
			}
			body = append(body, lines[next])
		}
		if !closed {
			// The cap removed the closing fence. Keep the body verbatim: the opener
			// stays out of the preview, and later passes cannot strip the code.
			if truncated && next == len(lines) {
				out = append(out, stash.stash(join(body, '\n')))
				break
			}
			out = append(out, line)
			if !sawCloser {
				out = append(out, lines[index+1:]...)
				break
			}
			continue
		}
		out = append(out, stash.stash(join(body, '\n')))
		index = next
	}
	return join(out, '\n')
}

// takeInlineCode is takeInlineCode (markdown-plain.ts:369).
func takeInlineCode(text []uint16, stash *stasher) []uint16 {
	out := make([]uint16, 0, len(text))
	for index := 0; index < len(text); {
		if text[index] != '`' {
			out = append(out, text[index])
			index++
			continue
		}
		run := 0
		for index+run < len(text) && text[index+run] == '`' {
			run++
		}
		close := findInlineCodeClose(text, index+run, run)
		if close == -1 {
			out = append(out, text[index:index+run]...)
			index += run
			continue
		}
		out = append(out, stash.stash(text[index+run:close])...)
		index = close + run
	}
	return out
}

// findInlineCodeClose is findInlineCodeClose (markdown-plain.ts:392).
func findInlineCodeClose(text []uint16, from, n int) int {
	for index := from; index < len(text); index++ {
		if text[index] != '`' {
			continue
		}
		run := 0
		for index+run < len(text) && text[index+run] == '`' {
			run++
		}
		if run == n {
			return index
		}
		index += run - 1
	}
	return -1
}

// takeLinks is takeLinks (markdown-plain.ts:403).
func takeLinks(text []uint16) []uint16 {
	closeBracket := closerAt(text, '[', ']')
	closeParen := closerAt(text, '(', ')')
	out := make([]uint16, 0, len(text))
	for index := 0; index < len(text); {
		image := startsWith(text, index, "![")
		if image || text[index] == '[' {
			open := index
			if image {
				open = index + 1
			}
			labelEnd := closeBracket[open]
			if labelEnd != -1 && labelEnd+1 < len(text) && text[labelEnd+1] == '(' {
				destEnd := closeParen[labelEnd+1]
				if destEnd != -1 {
					out = append(out, text[open+1:labelEnd]...)
					index = destEnd + 1
					continue
				}
			}
		}
		out = append(out, text[index])
		index++
	}
	return out
}

// closerAt is closerAt (markdown-plain.ts:428), with -1 for "undefined".
func closerAt(text []uint16, open, close uint16) []int {
	closeAt := make([]int, len(text))
	for index := range closeAt {
		closeAt[index] = -1
	}
	stack := []int{}
	for index := 0; index < len(text); index++ {
		if text[index] == '\\' {
			index++
			continue
		}
		if text[index] == open {
			stack = append(stack, index)
			continue
		}
		if text[index] == close && len(stack) > 0 {
			start := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			closeAt[start] = index
		}
	}
	return closeAt
}

// replaceAutolinks is the two autolink replaces of plainTextFromMarkdown
// (markdown-plain.ts:44-48): each match is restored and stashed again.
func replaceAutolinks(text []uint16, stash *stasher) []uint16 {
	text = replaceEmailAutolinks(replaceURLAutolinks(text, stash), stash)
	return text
}

// replaceURLAutolinks is /<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*)>/g.
func replaceURLAutolinks(text []uint16, stash *stasher) []uint16 {
	out := make([]uint16, 0, len(text))
	for index := 0; index < len(text); {
		if text[index] == '<' {
			if content, end, ok := urlAutolink(text, index); ok {
				out = append(out, stash.stash(stash.restore(content))...)
				index = end
				continue
			}
		}
		out = append(out, text[index])
		index++
	}
	return out
}

// urlAutolink matches the URL autolink at a `<`, returning the captured URL and
// the index just past the closing `>`.
func urlAutolink(text []uint16, at int) ([]uint16, int, bool) {
	index := at + 1
	if index >= len(text) || !isASCIIAlpha(text[index]) {
		return nil, 0, false
	}
	index++
	run := 0
	for index < len(text) {
		character := text[index]
		if !(isASCIIAlpha(character) || (character >= '0' && character <= '9') ||
			character == '+' || character == '.' || character == '-') {
			break
		}
		run++
		index++
	}
	if run < 1 || run > 31 || index >= len(text) || text[index] != ':' {
		return nil, 0, false
	}
	index++
	// The capture is the whole URL, scheme and colon included.
	contentStart := at + 1
	for index < len(text) && text[index] != '<' && text[index] != '>' && !isJSSpace(text[index]) {
		index++
	}
	if index >= len(text) || text[index] != '>' {
		return nil, 0, false
	}
	return text[contentStart:index], index + 1, true
}

// replaceEmailAutolinks is /<([^<>\s]+@[^<>\s]+\.[^<>\s]+)>/g.
func replaceEmailAutolinks(text []uint16, stash *stasher) []uint16 {
	out := make([]uint16, 0, len(text))
	for index := 0; index < len(text); {
		if text[index] == '<' {
			if content, end, ok := emailAutolink(text, index); ok {
				out = append(out, stash.stash(stash.restore(content))...)
				index = end
				continue
			}
		}
		out = append(out, text[index])
		index++
	}
	return out
}

// emailAutolink matches the email autolink at a `<`.
func emailAutolink(text []uint16, at int) ([]uint16, int, bool) {
	index := at + 1
	start := index
	for index < len(text) && text[index] != '<' && text[index] != '>' && !isJSSpace(text[index]) {
		index++
	}
	if index == start || index >= len(text) || text[index] != '>' {
		return nil, 0, false
	}
	content := text[start:index]
	for position := 1; position < len(content); position++ {
		if content[position] != '@' {
			continue
		}
		for dot := position + 2; dot <= len(content)-2; dot++ {
			if content[dot] == '.' {
				return content, index + 1, true
			}
		}
	}
	return nil, 0, false
}

// replaceDoubleStar is /(\*\*)(.*?)\1/g.
func replaceDoubleStar(text []uint16) []uint16 {
	out := make([]uint16, 0, len(text))
	for index := 0; index < len(text); {
		if index+1 < len(text) && text[index] == '*' && text[index+1] == '*' {
			found := -1
			for scan := index + 2; scan+1 < len(text); scan++ {
				if isLineTerminator(text[scan]) {
					break
				}
				if text[scan] == '*' && text[scan+1] == '*' {
					found = scan
					break
				}
			}
			if found != -1 {
				out = append(out, text[index+2:found]...)
				index = found + 2
				continue
			}
		}
		out = append(out, text[index])
		index++
	}
	return out
}

// replaceDoubleTilde is /~~(.*?)~~/g.
func replaceDoubleTilde(text []uint16) []uint16 {
	out := make([]uint16, 0, len(text))
	for index := 0; index < len(text); {
		if index+1 < len(text) && text[index] == '~' && text[index+1] == '~' {
			found := -1
			for scan := index + 2; scan+1 < len(text); scan++ {
				if isLineTerminator(text[scan]) {
					break
				}
				if text[scan] == '~' && text[scan+1] == '~' {
					found = scan
					break
				}
			}
			if found != -1 {
				out = append(out, text[index+2:found]...)
				index = found + 2
				continue
			}
		}
		out = append(out, text[index])
		index++
	}
	return out
}

// replaceSingleStar is /(\*)([^*\n]+)\1/g.
func replaceSingleStar(text []uint16) []uint16 {
	out := make([]uint16, 0, len(text))
	for index := 0; index < len(text); {
		if text[index] == '*' && index+1 < len(text) && text[index+1] != '*' && text[index+1] != '\n' {
			end := index + 1
			for end < len(text) && text[end] != '*' && text[end] != '\n' {
				end++
			}
			if end < len(text) && text[end] == '*' {
				out = append(out, text[index+1:end]...)
				index = end + 1
				continue
			}
		}
		out = append(out, text[index])
		index++
	}
	return out
}
