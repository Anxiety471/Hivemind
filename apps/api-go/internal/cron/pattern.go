package cron

import (
	"errors"
	"strconv"
	"strings"
	"time"
)

// A pattern is the five-field schedule croner's CronPattern parses for the
// routines code: the seconds field is 0, the year field is "*", and matching
// happens on a clock that never changes (the caller reads UTC fields as wall
// time). Parse rejects everything croner rejects, so NextDate skips the same
// expressions nextCronDate does (packages/core/src/routines/schedule.ts:388).
type pattern struct {
	minutes []bool
	hours   []bool
	days    []bool // index day-1
	months  []bool // index month-1
	// dow holds, per weekday (0 Sunday), 0 for absent, 63 for every
	// occurrence, another bit set for the nth (#), or 32 for the last (L).
	dow             [7]int
	nearestWeekdays []bool // "15W", index day-1
	lastDayOfMonth  bool
	lastWeekday     bool
	starDOM         bool
	starDOW         bool
	useAndLogic     bool
}

// occurrenceBits is O (croner's CronPattern): bit per occurrence in a month.
var occurrenceBits = [5]int{1, 2, 4, 8, 16}

var errPattern = errors.New("invalid cron expression")

// parsePattern is CronPattern's parse for the five fields nextCronDate passes
// it. The transformations and their order follow croner 10.0.1: day-of-month
// L/LW, wildcard flags, month and weekday names, the day-of-week "+" modifier,
// "?" as "*", then the per-field grammar.
func parsePattern(expr string) (*pattern, error) {
	text := strings.TrimSpace(expr)
	fields := strings.Fields(text)
	if len(fields) < 5 || len(fields) > 7 {
		return nil, errPattern
	}
	if len(fields) == 5 {
		fields = append([]string{"0"}, fields...)
	}
	if len(fields) == 6 {
		fields = append(fields, "*")
	}
	p := &pattern{
		minutes: make([]bool, 60),
		hours:   make([]bool, 24),
		days:    make([]bool, 31),
		months:  make([]bool, 12),

		nearestWeekdays: make([]bool, 31),
	}
	// Croner's field order after the padding: second, minute, hour, day,
	// month, dayOfWeek, year.
	dayOfMonth := fields[3]
	month := fields[4]
	dayOfWeek := fields[5]
	if strings.ToUpper(dayOfMonth) == "LW" {
		p.lastWeekday = true
		dayOfMonth = ""
	} else if strings.Contains(strings.ToUpper(dayOfMonth), "L") {
		dayOfMonth = removeFold(dayOfMonth, "L")
		p.lastDayOfMonth = true
	}
	if dayOfMonth == "*" {
		p.starDOM = true
	}
	if len(month) >= 3 {
		month = replaceAlphaMonths(month)
	}
	if len(dayOfWeek) >= 3 {
		dayOfWeek = replaceAlphaDays(dayOfWeek)
	}
	if strings.HasPrefix(dayOfWeek, "+") {
		p.useAndLogic = true
		dayOfWeek = dayOfWeek[1:]
		if dayOfWeek == "" {
			return nil, errPattern
		}
	}
	if dayOfWeek == "*" {
		p.starDOW = true
	}
	fields[3], fields[4], fields[5] = dayOfMonth, month, dayOfWeek
	if strings.Contains(text, "?") {
		for index := range fields {
			fields[index] = strings.ReplaceAll(fields[index], "?", "*")
		}
	}
	if err := checkIllegal(fields); err != nil {
		return nil, err
	}
	steps := []struct {
		field  string
		offset int
		fill   int
	}{
		{"minute", 0, 1},
		{"hour", 0, 1},
		{"day", -1, 1},
		{"month", -1, 1},
		{"dow", 0, 63},
	}
	expressions := []string{fields[1], fields[2], fields[3], fields[4], fields[5]}
	for index, step := range steps {
		if err := p.part(step.field, expressions[index], step.offset, step.fill); err != nil {
			return nil, err
		}
	}
	// p.dow[7] cannot be reached: setPart folds 7 into 0 first.
	return p, nil
}

// checkIllegal is throwAtIllegalCharacters: field 3 also allows W and L, field
// 5 also allows # and L.
func checkIllegal(fields []string) error {
	for index, field := range fields {
		for _, r := range field {
			allowed := (r >= '0' && r <= '9') || r == '*' || r == '/' || r == ',' || r == '-'
			if index == 3 {
				allowed = allowed || r == 'W' || r == 'w' || r == 'L' || r == 'l'
			}
			if index == 5 {
				allowed = allowed || r == '#' || r == 'L' || r == 'l'
			}
			if !allowed {
				return errPattern
			}
		}
	}
	return nil
}

func replaceAlphaMonths(text string) string {
	names := []string{"jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"}
	for index, name := range names {
		text = replaceFold(text, name, strconv.Itoa(index+1))
	}
	return text
}

// replaceAlphaDays is replaceAlphaDays: "-sun" first, so a range ending on
// Sunday is 5-7 and setPart folds 7 into 0.
func replaceAlphaDays(text string) string {
	text = replaceFold(text, "-sun", "-7")
	names := []string{"sun", "mon", "tue", "wed", "thu", "fri", "sat"}
	for index, name := range names {
		text = replaceFold(text, name, string(rune('0'+index)))
	}
	return text
}

// replaceFold is String.prototype.replace with the /gi flag for an ASCII token.
func replaceFold(text, old, replacement string) string {
	lower := strings.ToLower(text)
	token := strings.ToLower(old)
	var out strings.Builder
	for {
		index := strings.Index(lower, token)
		if index < 0 {
			out.WriteString(text)
			return out.String()
		}
		out.WriteString(text[:index])
		out.WriteString(replacement)
		text = text[index+len(token):]
		lower = lower[index+len(token):]
	}
}

func removeFold(text, token string) string {
	return replaceFold(text, token, "")
}

func (p *pattern) part(field, expr string, offset, fill int) error {
	if expr == "" && !(field == "day" && (p.lastDayOfMonth || p.lastWeekday)) {
		return errPattern
	}
	if expr == "*" {
		p.fill(field, fill)
		return nil
	}
	if strings.Contains(expr, ",") {
		for _, part := range strings.Split(expr, ",") {
			if err := p.part(field, part, offset, fill); err != nil {
				return err
			}
		}
		return nil
	}
	switch {
	case strings.Contains(expr, "-") && strings.Contains(expr, "/"):
		return p.rangeWithStepping(field, expr, offset, fill)
	case strings.Contains(expr, "-"):
		return p.rangeOf(field, expr, offset, fill)
	case strings.Contains(expr, "/"):
		return p.stepping(field, expr, offset, fill)
	case expr != "":
		return p.number(field, expr, offset, fill)
	}
	return nil
}

// length is the field's array length, croner's bound on a step.
func (p *pattern) length(field string) int {
	switch field {
	case "minute":
		return 60
	case "hour":
		return 24
	case "day":
		return 31
	case "month":
		return 12
	case "dow":
		return 7
	}
	return 0
}

func (p *pattern) fill(field string, fill int) {
	switch field {
	case "minute":
		for index := range p.minutes {
			p.minutes[index] = true
		}
	case "hour":
		for index := range p.hours {
			p.hours[index] = true
		}
	case "day":
		for index := range p.days {
			p.days[index] = true
		}
	case "month":
		for index := range p.months {
			p.months[index] = true
		}
	case "dow":
		for index := range p.dow {
			p.dow[index] = fill
		}
	}
}

// number is handleNumber.
func (p *pattern) number(field, expr string, offset, fill int) error {
	rest, nth, err := extractNth(expr, field)
	if err != nil {
		return err
	}
	target := field
	if strings.Contains(strings.ToUpper(expr), "W") {
		if field != "day" {
			return errPattern
		}
		target = "nearestWeekdays"
	}
	value, err := leadingInt(rest)
	if err != nil {
		return err
	}
	return p.setPart(target, value+offset, nth, fill)
}

// rangeOf is handleRange.
func (p *pattern) rangeOf(field, expr string, offset, fill int) error {
	if strings.Contains(strings.ToUpper(expr), "W") {
		return errPattern
	}
	rest, nth, err := extractNth(expr, field)
	if err != nil {
		return err
	}
	parts := strings.Split(rest, "-")
	if len(parts) != 2 {
		return errPattern
	}
	low, err := leadingInt(parts[0])
	if err != nil {
		return err
	}
	high, err := leadingInt(parts[1])
	if err != nil {
		return err
	}
	low, high = low+offset, high+offset
	if low > high {
		return errPattern
	}
	for value := low; value <= high; value++ {
		if err := p.setPart(field, value, nth, fill); err != nil {
			return err
		}
	}
	return nil
}

// rangeWithStepping is handleRangeWithStepping.
func (p *pattern) rangeWithStepping(field, expr string, offset, fill int) error {
	if strings.Contains(strings.ToUpper(expr), "W") {
		return errPattern
	}
	rest, nth, err := extractNth(expr, field)
	if err != nil {
		return err
	}
	parts := strings.Split(rest, "-")
	if len(parts) != 2 || !strings.Contains(parts[1], "/") {
		return errPattern
	}
	highAndStep := strings.Split(parts[1], "/")
	if len(highAndStep) != 2 {
		return errPattern
	}
	low, err := leadingInt(parts[0])
	if err != nil {
		return err
	}
	high, err := leadingInt(highAndStep[0])
	if err != nil {
		return err
	}
	steps, err := leadingInt(highAndStep[1])
	if err != nil {
		return err
	}
	low, high = low+offset, high+offset
	if low > high || steps == 0 || steps > p.length(field) {
		return errPattern
	}
	for value := low; value <= high; value += steps {
		if err := p.setPart(field, value, nth, fill); err != nil {
			return err
		}
	}
	return nil
}

// stepping is handleStepping: only "*/step" is allowed.
func (p *pattern) stepping(field, expr string, offset, fill int) error {
	if strings.Contains(strings.ToUpper(expr), "W") {
		return errPattern
	}
	rest, nth, err := extractNth(expr, field)
	if err != nil {
		return err
	}
	parts := strings.Split(rest, "/")
	if len(parts) != 2 || parts[0] != "*" {
		return errPattern
	}
	steps, err := leadingInt(parts[1])
	if err != nil {
		return err
	}
	if steps == 0 || steps > p.length(field) {
		return errPattern
	}
	for value := 0; value < p.length(field); value += steps {
		if err := p.setPart(field, value, nth, fill); err != nil {
			return err
		}
	}
	return nil
}

// extractNth pulls the day-of-week "#n" or trailing "L" off an expression.
func extractNth(expr, field string) (string, string, error) {
	if index := strings.Index(expr, "#"); index >= 0 {
		if field != "dow" {
			return "", "", errPattern
		}
		rest := expr[:index]
		nth := expr[index+1:]
		if next := strings.Index(nth, "#"); next >= 0 {
			nth = nth[:next]
		}
		return rest, nth, nil
	}
	if strings.HasSuffix(strings.ToUpper(expr), "L") {
		if field != "dow" {
			return "", "", errPattern
		}
		return expr[:len(expr)-1], "L", nil
	}
	return expr, "", nil
}

func (p *pattern) setPart(field string, value int, nth string, fill int) error {
	switch field {
	case "minute":
		if value < 0 || value >= 60 {
			return errPattern
		}
		p.minutes[value] = true
	case "hour":
		if value < 0 || value >= 24 {
			return errPattern
		}
		p.hours[value] = true
	case "day", "nearestWeekdays":
		if value < 0 || value >= 31 {
			return errPattern
		}
		if field == "day" {
			p.days[value] = true
		} else {
			p.nearestWeekdays[value] = true
		}
	case "month":
		if value < 0 || value >= 12 {
			return errPattern
		}
		p.months[value] = true
	case "dow":
		if value == 7 {
			value = 0
		}
		if value < 0 || value > 6 {
			return errPattern
		}
		return p.setNthWeekday(value, nth, fill)
	default:
		return errPattern
	}
	return nil
}

// setNthWeekday is setNthWeekdayOfMonth.
func (p *pattern) setNthWeekday(weekday int, nth string, fill int) error {
	switch {
	case nth == "":
		p.dow[weekday] = fill
	case strings.EqualFold(nth, "L"):
		p.dow[weekday] |= 32
	default:
		value, err := leadingInt(nth)
		if err != nil {
			return err
		}
		if value > 0 && value < 6 {
			p.dow[weekday] |= occurrenceBits[value-1]
			return nil
		}
		return errPattern
	}
	return nil
}

// leadingInt is parseInt(expr, 10): leading digits, NaN for none.
func leadingInt(expr string) (int, error) {
	end := 0
	for end < len(expr) && expr[end] >= '0' && expr[end] <= '9' {
		end++
	}
	if end == 0 {
		return 0, errPattern
	}
	value := 0
	for _, r := range expr[:end] {
		if value > 1_000_000 { // far beyond any field's range; avoid overflow
			return 0, errPattern
		}
		value = value*10 + int(r-'0')
	}
	return value, nil
}

func lastDayOfMonth(year int, month time.Month) int {
	return time.Date(year, month+1, 0, 0, 0, 0, 0, time.UTC).Day()
}

func weekdayOf(year int, month time.Month, day int) int {
	return int(time.Date(year, month, day, 0, 0, 0, 0, time.UTC).Weekday())
}

// lastWeekdayOfMonth is getLastWeekday: Friday when the month ends on a
// weekend, the last day otherwise.
func lastWeekdayOfMonth(year int, month time.Month) int {
	last := lastDayOfMonth(year, month)
	switch weekdayOf(year, month, last) {
	case 0:
		return last - 2
	case 6:
		return last - 1
	}
	return last
}

// nearestWeekday is getNearestWeekday: the weekday nearest day, staying inside
// the month.
func nearestWeekday(year int, month time.Month, day int) int {
	last := lastDayOfMonth(year, month)
	if day > last {
		return -1
	}
	switch weekdayOf(year, month, day) {
	case 0:
		if day == last {
			return day - 2
		}
		return day + 1
	case 6:
		if day == 1 {
			return day + 2
		}
		return day - 1
	}
	return day
}

// isNthWeekdayOfMonth is isNthWeekdayOfMonth: the nth occurrence bit, or the
// last one.
func isNthWeekdayOfMonth(year int, month time.Month, day, nth int) bool {
	weekday := weekdayOf(year, month, day)
	occurrence := 0
	for candidate := 1; candidate <= day; candidate++ {
		if weekdayOf(year, month, candidate) == weekday {
			occurrence++
		}
	}
	if nth&63 != 0 && occurrence >= 1 && occurrence <= len(occurrenceBits) && occurrenceBits[occurrence-1]&nth != 0 {
		return true
	}
	if nth&32 != 0 {
		for candidate := day + 1; candidate <= lastDayOfMonth(year, month); candidate++ {
			if weekdayOf(year, month, candidate) == weekday {
				return false
			}
		}
		return true
	}
	return false
}

// matchesDate is the day half of croner's CronDate.match: the day-of-month
// set (with W, L and LW) combined with the day-of-week set as nextRun's
// findNext does.
func (p *pattern) matchesDate(year int, month time.Month, day int) bool {
	if !p.months[int(month)-1] {
		return false
	}
	dom := p.days[day-1]
	if !dom {
		for index, present := range p.nearestWeekdays {
			if present && nearestWeekday(year, month, index+1) == day {
				dom = true
				break
			}
		}
	}
	if p.lastWeekday && lastWeekdayOfMonth(year, month) == day {
		dom = true
	}
	if p.lastDayOfMonth && lastDayOfMonth(year, month) == day {
		dom = true
	}
	if p.starDOW {
		return dom
	}
	weekday := weekdayOf(year, month, day)
	value := p.dow[weekday]
	dow := value != 0
	if dow && value&63 != 0 {
		dow = isNthWeekdayOfMonth(year, month, day, value)
	}
	if p.useAndLogic {
		return dom && dow
	}
	if !p.starDOM {
		return dom || dow
	}
	return dom && dow
}

// next is Cron.nextRun over a clock that never changes: the earliest instant
// after from whose fields match, with seconds 0. It gives up past year 2999,
// where croner's starYear limit stops.
func (p *pattern) next(from time.Time) (time.Time, bool) {
	from = from.UTC()
	fromMs := from.UnixMilli()
	year, month, day := from.Date()
	for {
		if year > 2999 {
			return time.Time{}, false
		}
		if !p.months[int(month)-1] {
			year, month, day = nextMonth(year, month)
			continue
		}
		if p.matchesDate(year, month, day) {
			for hour := 0; hour < 24; hour++ {
				if !p.hours[hour] {
					continue
				}
				for minute := 0; minute < 60; minute++ {
					if !p.minutes[minute] {
						continue
					}
					candidate := time.Date(year, month, day, hour, minute, 0, 0, time.UTC)
					if candidate.UnixMilli() > fromMs {
						return candidate, true
					}
				}
			}
		}
		day++
		if day > lastDayOfMonth(year, month) {
			year, month, day = nextMonth(year, month)
		}
	}
}

func nextMonth(year int, month time.Month) (int, time.Month, int) {
	month++
	if month > 12 {
		month = 1
		year++
	}
	return year, month, 1
}
