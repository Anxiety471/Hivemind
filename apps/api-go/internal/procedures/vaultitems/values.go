package vaultitems

import (
	"encoding/json"
	"log/slog"
	"net"
	"net/url"
	"regexp"
	"strings"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/agentsecrets"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/wtf8"
)

// The value formats below are packages/contracts/src/bots/bot-secrets.ts. A list shows a login's
// first visible field, a card's summary or a contact; a value that does not decode is simply not
// previewed (itemPreview catches every error), so each decoder reports ok instead of failing.

const (
	loginFieldLimit        = 40
	loginFieldLabelMax     = 64
	loginFieldValueMax     = 4096
	botSecretValueMax      = 16_384
	authenticatorKeyMaxLen = 1024
	titleMax               = 80
	noteMax                = 200
)

var botSecretName = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,63}$`)

// SecretHeaderName (bot-secrets.ts:16-24): a token name, minus the headers the transport owns.
var secretHeaderName = regexp.MustCompile("^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,120}$")

var reservedSecretHeader = regexp.MustCompile(
	`(?i)^(host|connection|content-length|content-type|transfer-encoding|te|trailer|upgrade|cookie|origin|referer|accept|proxy-.*|sec-.*|.*forwarded.*)$`)

// decodeLoginPreview is decodeLoginSecret + itemPreview's login branch.
func decodeLoginPreview(plaintext string) (username string, hasUsername, otp bool, ok bool) {
	var parsed any
	if json.Unmarshal([]byte(plaintext), &parsed) != nil {
		return "", false, false, false
	}
	record, isRecord := parsed.(map[string]any)
	if !isRecord {
		return "", false, false, false
	}
	// Legacy {username, password}: the fields are built as-is, so the username is not trimmed.
	if usernameValue, hasUser := record["username"].(string); hasUser {
		if password, hasPassword := record["password"].(string); hasPassword {
			if utf16Len(usernameValue) >= 1 && utf16Len(usernameValue) <= 512 &&
				utf16Len(password) >= 1 && utf16Len(password) <= 4096 {
				return usernameValue, true, false, true
			}
			return "", false, false, false
		}
	}
	fieldsRaw, isArray := record["fields"].([]any)
	if !isArray || len(fieldsRaw) < 1 || len(fieldsRaw) > loginFieldLimit {
		return "", false, false, false
	}
	labels := make(map[string]bool, len(fieldsRaw))
	for _, raw := range fieldsRaw {
		field, isField := raw.(map[string]any)
		if !isField {
			return "", false, false, false
		}
		label, isString := field["label"].(string)
		label = trimJS(label)
		if !isString || utf16Len(label) < 1 || utf16Len(label) > loginFieldLabelMax {
			return "", false, false, false
		}
		key := strings.ToLower(label)
		if labels[key] {
			return "", false, false, false
		}
		labels[key] = true
		value, isValue := field["value"].(string)
		hidden, isHidden := field["hidden"].(bool)
		if !isValue || len(value) > loginFieldValueMax || !isHidden {
			return "", false, false, false
		}
		if !hidden {
			value = trimJS(value)
			if value == "" {
				return "", false, false, false
			}
			if !hasUsername {
				username, hasUsername = value, true
			}
		}
	}
	if rawOtp, present := record["otp"]; present {
		if rawOtp != nil {
			text, isText := rawOtp.(string)
			if !isText {
				return "", false, false, false
			}
			text = trimJS(text)
			if len(text) > authenticatorKeyMaxLen {
				return "", false, false, false
			}
			if text != "" {
				if !validAuthenticatorKey(text) {
					return "", false, false, false
				}
				otp = true
			}
		}
	}
	// The schema also caps JSON.stringify(login) at BOT_SECRET_VALUE_MAX_LENGTH.
	if encoded, err := json.Marshal(record); err != nil || utf16Len(string(encoded)) > botSecretValueMax {
		return "", false, false, false
	}
	return username, hasUsername, otp, true
}

func validAuthenticatorKey(text string) bool {
	trimmed := trimJS(text)
	secret := trimmed
	if strings.HasPrefix(strings.ToLower(trimmed), "otpauth:") {
		parsed, err := url.Parse(trimmed)
		if err != nil || strings.ToLower(parsed.Host) != "totp" {
			return false
		}
		params := map[string]string{}
		for key, values := range parsed.Query() {
			if len(values) > 0 {
				params[strings.ToLower(key)] = values[0]
			}
		}
		secret = params["secret"]
		algorithm := strings.ToLower(params["algorithm"])
		if algorithm == "" {
			algorithm = "sha1"
		}
		if algorithm != "sha1" && algorithm != "sha256" && algorithm != "sha512" {
			return false
		}
		digits, period := params["digits"], params["period"]
		if digits == "" {
			digits = "6"
		}
		if period == "" {
			period = "30"
		}
		if digits != "6" && digits != "8" {
			return false
		}
		if period != "30" && period != "60" {
			return false
		}
	}
	secret = strings.ToUpper(strings.NewReplacer(" ", "", "-", "").Replace(secret))
	padding := 0
	for padding < len(secret) && secret[len(secret)-1-padding] == '=' {
		padding++
	}
	secret = secret[:len(secret)-padding]
	remainder := len(secret) % 8
	if remainder == 1 || remainder == 3 || remainder == 6 {
		return false
	}
	if padding > 0 && padding != (8-remainder)%8 {
		return false
	}
	return regexp.MustCompile(`^[A-Z2-7]{16,256}$`).MatchString(secret)
}

// decodeCardPreview is decodeCardSecret + cardSummary.
func decodeCardPreview(plaintext string) (map[string]any, bool) {
	var parsed any
	if json.Unmarshal([]byte(plaintext), &parsed) != nil {
		return nil, false
	}
	record, isRecord := parsed.(map[string]any)
	if !isRecord {
		return nil, false
	}
	allowed := map[string]bool{
		"number": true, "expMonth": true, "expYear": true, "cvc": true, "name": true, "billing": true,
	}
	for key := range record {
		if !allowed[key] {
			return nil, false
		}
	}
	numberText, isString := record["number"].(string)
	if !isString {
		return nil, false
	}
	number := strings.NewReplacer(" ", "", "-", "").Replace(numberText)
	if !regexp.MustCompile(`^\d{12,19}$`).MatchString(number) || !luhnValid(number) {
		return nil, false
	}
	expMonth, monthOK := integerValue(record["expMonth"])
	expYear, yearOK := integerValue(record["expYear"])
	if !monthOK || expMonth < 1 || expMonth > 12 || !yearOK || expYear < 2000 || expYear > 2100 {
		return nil, false
	}
	if rawCVC, present := record["cvc"]; present && rawCVC != nil {
		cvc, isCVC := rawCVC.(string)
		if !isCVC || len(trimJS(cvc)) > 4 {
			return nil, false
		}
		if trimmed := trimJS(cvc); trimmed != "" && !regexp.MustCompile(`^\d{3,4}$`).MatchString(trimmed) {
			return nil, false
		}
	}
	name, nameOK := optionalText(record, "name", 200)
	if !nameOK {
		return nil, false
	}
	billing, billingOK := optionalText(record, "billing", 64)
	if !billingOK || (billing != "" && !botSecretName.MatchString(billing)) {
		return nil, false
	}
	summary := map[string]any{
		"brand":    cardBrand(number),
		"last4":    number[len(number)-4:],
		"expMonth": expMonth,
		"expYear":  expYear,
	}
	if name != "" {
		summary["name"] = name
	}
	if billing != "" {
		summary["billing"] = billing
	}
	return summary, true
}

// decodeContactPreview is decodeContactSecret (ContactFields.strict(), at least one value).
func decodeContactPreview(plaintext string) (map[string]any, bool) {
	var parsed any
	if json.Unmarshal([]byte(plaintext), &parsed) != nil {
		return nil, false
	}
	record, isRecord := parsed.(map[string]any)
	if !isRecord {
		return nil, false
	}
	limits := map[string]int{
		"name": 200, "line1": 200, "line2": 200, "city": 100, "region": 100,
		"postalCode": 20, "country": 100, "phone": 40, "email": 254,
	}
	out := map[string]any{}
	for key := range record {
		if _, known := limits[key]; !known {
			return nil, false
		}
	}
	anyValue := false
	for key, maximum := range limits {
		value, ok := optionalText(record, key, maximum)
		if !ok {
			return nil, false
		}
		if value != "" {
			out[key] = value
			anyValue = true
		}
	}
	if !anyValue {
		return nil, false
	}
	return out, true
}

func optionalText(record map[string]any, key string, maximum int) (string, bool) {
	raw, present := record[key]
	if !present || raw == nil {
		return "", true
	}
	text, isString := raw.(string)
	if !isString {
		return "", false
	}
	text = trimJS(text)
	if utf16Len(text) > maximum {
		return "", false
	}
	return text, true
}

func integerValue(value any) (int, bool) {
	number, isNumber := value.(float64)
	if !isNumber || number != float64(int(number)) {
		return 0, false
	}
	return int(number), true
}

func luhnValid(digits string) bool {
	sum := 0
	for index := 0; index < len(digits); index++ {
		digit := int(digits[len(digits)-1-index] - '0')
		if index%2 == 1 {
			digit *= 2
			if digit > 9 {
				digit -= 9
			}
		}
		sum += digit
	}
	return sum%10 == 0
}

var cardBrands = []struct {
	pattern *regexp.Regexp
	name    string
}{
	{regexp.MustCompile(`^4`), "Visa"},
	{regexp.MustCompile(`^(5[1-5]|222[1-9]|22[3-9]|2[3-6]|27[01]|2720)`), "Mastercard"},
	{regexp.MustCompile(`^3[47]`), "Amex"},
	{regexp.MustCompile(`^(6011|65|64[4-9]|622)`), "Discover"},
	{regexp.MustCompile(`^3(0[0-5]|[68])`), "Diners Club"},
	{regexp.MustCompile(`^35(2[89]|[3-8])`), "JCB"},
	{regexp.MustCompile(`^62`), "UnionPay"},
}

func cardBrand(number string) string {
	for _, brand := range cardBrands {
		if brand.pattern.MatchString(number) {
			return brand.name
		}
	}
	return "Card"
}

func cardTitle(summary map[string]any) string {
	return summary["brand"].(string) + " ·· " + summary["last4"].(string)
}

// destinationValid is normalizeSecretDestination's acceptance: a stored destination that no
// longer passes is listed with auth:null so its owner can still remove it.
func destinationValid(name, origin string, auth map[string]any) bool {
	if !botSecretName.MatchString(name) {
		return false
	}
	kind, _ := auth["type"].(string)
	siteless := kind == "command" || kind == "card" || kind == "contact"
	if siteless {
		if origin != "" {
			return false
		}
		// A command's name must export to a usable, non-reserved environment variable.
		if kind == "command" {
			variable := agentsecrets.CommandVariableName(name)
			if agentsecrets.CommandVariableProblem(variable) != "" {
				return false
			}
		}
		return true
	}
	if origin == "" || utf16Len(origin) > 2048 {
		return false
	}
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Host == "" {
		return false
	}
	if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return false
	}
	if parsed.Path != "" && parsed.Path != "/" {
		return false
	}
	host := strings.ToLower(strings.TrimSuffix(parsed.Hostname(), "."))
	if isMetadataHost(host) {
		return false
	}
	if parsed.Scheme == "https" {
		return true
	}
	if parsed.Scheme != "http" || !allowPrivateHTTP() {
		return false
	}
	return kind != "login" && isPrivateHost(host)
}

func isMetadataHost(host string) bool {
	switch host {
	case "metadata.google.internal", "metadata.goog":
		return true
	}
	switch host {
	case "169.254.169.254", "169.254.170.2", "100.100.100.200", "fd00:ec2::254":
		return true
	}
	return false
}

func allowPrivateHTTP() bool { return envValue("RAKAZO_SECRETS_ALLOW_PRIVATE_HTTP") == "1" }

func isPrivateHost(host string) bool {
	if host == "localhost" || strings.HasSuffix(host, ".localhost") || strings.HasSuffix(host, ".local") {
		return true
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return false
	}
	if ip.IsLoopback() {
		return true
	}
	if v4 := ip.To4(); v4 != nil {
		return v4[0] == 10 ||
			(v4[0] == 100 && v4[1] >= 64 && v4[1] <= 127) ||
			(v4[0] == 172 && v4[1] >= 16 && v4[1] <= 31) ||
			(v4[0] == 192 && v4[1] == 168)
	}
	return false
}

// authValue cleans a stored auth object as BotSecretAuth does (z.object strips unknown keys),
// returning the cleaned value and whether it is a member of the union.
func authValue(raw any) (map[string]any, bool) {
	record, isRecord := raw.(map[string]any)
	if !isRecord {
		return nil, false
	}
	kind, _ := record["type"].(string)
	switch kind {
	case "bearer", "login", "command", "card", "contact":
		return map[string]any{"type": kind}, true
	case "header":
		name, ok := record["name"].(string)
		if !ok || !secretHeaderName.MatchString(name) || reservedSecretHeader.MatchString(name) {
			return nil, false
		}
		return map[string]any{"type": "header", "name": name}, true
	case "basic":
		username, ok := record["username"].(string)
		if !ok || utf16Len(username) < 1 || utf16Len(username) > 200 || strings.ContainsAny(username, ":\r\n") {
			return nil, false
		}
		return map[string]any{"type": "basic", "username": username}, true
	}
	return nil, false
}

// previewFor is itemPreview: only login, card and contact values have one.
func previewFor(auth map[string]any, ciphertext, recordID string, open func() (string, error)) *Preview {
	kind, _ := auth["type"].(string)
	if kind != "login" && kind != "card" && kind != "contact" {
		return nil
	}
	plaintext, err := open()
	if err != nil {
		slog.Default().Warn("vault item could not be read for its preview", "itemId", recordID, "error", err)
		return nil
	}
	switch kind {
	case "card":
		summary, ok := decodeCardPreview(plaintext)
		if !ok {
			return nil
		}
		return &Preview{Card: summary}
	case "contact":
		contact, ok := decodeContactPreview(plaintext)
		if !ok {
			return nil
		}
		return &Preview{Contact: contact}
	default:
		username, hasUsername, otp, ok := decodeLoginPreview(plaintext)
		if !ok {
			return nil
		}
		preview := &Preview{OTP: otp}
		if hasUsername {
			preview.Username = &username
		}
		return preview
	}
}

// titleFor is vaultItemTitle: the owner's title, else the item's own description.
func titleFor(rowTitle, origin, name string, preview *Preview) string {
	if rowTitle != "" {
		return rowTitle
	}
	if preview != nil && preview.Card != nil {
		return cardTitle(preview.Card)
	}
	if preview != nil && preview.Contact != nil {
		if contactName, ok := preview.Contact["name"].(string); ok && contactName != "" {
			return contactName
		}
	}
	if parsed, err := url.Parse(origin); err == nil && parsed.Scheme != "" &&
		(parsed.Host != "" || parsed.Opaque != "") {
		return strings.TrimPrefix(parsed.Host, "www.")
	}
	return name
}

func trimJS(value string) string {
	return strings.TrimFunc(value, func(r rune) bool {
		switch r {
		case '\u0009', '\u000A', '\u000B', '\u000C', '\u000D', '\u0020', '\u00A0',
			'\u1680', '\u2028', '\u2029', '\u202F', '\u205F', '\u3000', '\uFEFF':
			return true
		}
		return r >= '\u2000' && r <= '\u200A'
	})
}

func utf16Len(value string) int { return len(wtf8.Units(value)) }
