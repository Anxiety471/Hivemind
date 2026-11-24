package vaultstore

// canonicalSecretValue (packages/adapters/src/secrets/bot-secrets.ts:824-843): the value as it
// is saved. A login, card or contact is re-encoded in the current shape, so every reader sees
// one form; a command variable must be exportable; a bearer/header/basic value must survive a
// header. A value of the wrong shape is refused with the adapter's message and never quoted.

import (
	"encoding/base64"
	"encoding/json"
	"regexp"
	"strconv"
	"strings"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/vaultitems"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/whatwgurl"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/wtf8"
	"golang.org/x/text/cases"
	"golang.org/x/text/language"
)

// casesLower is String.prototype.toLowerCase (the Unicode default full lowercase mapping).
var casesLower = cases.Lower(language.Und).String

const (
	loginFieldLimit   = 8 // LOGIN_FIELD_LIMIT
	loginLabelMax     = 64
	loginValueMax     = 4096
	secretValueMax    = 16_384
	loginJSONMax      = 16_384
	loginLegacyUser   = 512
	loginLegacyPass   = 4096
	authenticatorMax  = 1024
	loginFieldDefault = "Username"
)

// Refusal messages (bot-secrets.ts:1018-1022,149-153,806-812).
const (
	loginRefusal       = "A website login needs a label and a value for every field"
	cardRefusal        = "Invalid card"
	contactRefusal     = "Invalid contact"
	unreadableKeyError = "This authenticator key can't be read."
	unusableCredential = "Credential cannot be used with this authentication method"
	invalidLengthError = "Invalid credential length"
)

var cardDigits = regexp.MustCompile(`^\d{12,19}$`)
var cardCVC = regexp.MustCompile(`^\d{3,4}$`)

// canonicalValue is canonicalSecretValue for an already normalized destination.
func canonicalValue(destination Destination, plaintext string) (string, error) {
	switch destination.Auth.Type {
	case "login":
		return canonicalLogin(plaintext)
	case "card":
		return canonicalCard(plaintext)
	case "contact":
		return canonicalContact(plaintext)
	}
	return plaintext, nil
}

// checkValueKind is prepareBotSecret's per-kind check before the vault is read
// (bot-secrets.ts:873-893): a login/card/contact is canonicalized, a command variable must be
// an environment value, and a header/bearer/basic value must survive a header.
func checkValueKind(destination Destination, plaintext string) (string, error) {
	switch destination.Auth.Type {
	case "login", "card", "contact":
		return canonicalValue(destination, plaintext)
	case "command":
		// NUL cannot be an environment value, and an unpaired surrogate cannot be
		// percent-encoded, which would abort every later shell command for the bot.
		if strings.ContainsRune(plaintext, 0) || wtf8.ReplaceSurrogates(plaintext) != plaintext {
			return "", badRequest(unusableCredential)
		}
		return plaintext, nil
	}
	if err := headerValue(destination.Auth, plaintext); err != nil {
		return "", err
	}
	return plaintext, nil
}

// headerValue is credentialHeader (bot-secrets.ts:300-325): the value is built the way the
// adapter builds it and then asked of a Headers object, which refuses a value with NUL, CR or
// LF, a code unit above 0xFF, and one whose leading or trailing HTTP whitespace it would strip.
func headerValue(auth Auth, plaintext string) error {
	switch auth.Type {
	case "bearer", "header", "basic":
	default:
		return badRequest(unusableCredential)
	}
	value := plaintext
	if auth.Type == "bearer" {
		value = "Bearer " + plaintext
	}
	if auth.Type == "basic" {
		value = "Basic " + base64.StdEncoding.EncodeToString([]byte(wtf8.ToUTF8(auth.Username+":"+plaintext)))
	}
	for _, r := range value {
		if r == 0 || r == '\r' || r == '\n' || r > 0xFF {
			return badRequest(unusableCredential)
		}
	}
	// ByteString conversion turns an unpaired surrogate into a value above 0xFF; the range loop
	// above reads it as RuneError, so check the raw text as well.
	if wtf8.ReplaceSurrogates(value) != value {
		return badRequest(unusableCredential)
	}
	if strings.HasPrefix(value, " ") || strings.HasPrefix(value, "\t") ||
		strings.HasSuffix(value, " ") || strings.HasSuffix(value, "\t") {
		return badRequest(unusableCredential)
	}
	return nil
}

// loginField is one LoginField of a revealed or stored login.
type loginField struct {
	Label  string `json:"label"`
	Value  string `json:"value"`
	Hidden bool   `json:"hidden"`
}

// loginValue is LoginSecretValue / VaultRevealed's login branch. OTP is present whenever the
// stored value carried the key, including the empty string decodeLoginSecret returns for "".
type loginValue struct {
	Fields []loginField `json:"fields"`
	OTP    *string      `json:"otp,omitempty"`
}

// canonicalLogin is decodeLoginSecret + encodeLoginSecret (bot-secrets.ts:389-411,816-822).
func canonicalLogin(plaintext string) (string, error) {
	value, err := decodeLogin(plaintext)
	if err != nil {
		return "", err
	}
	return encodeLogin(value)
}

// encodeLogin is encodeLoginSecret's JSON: fields then otp, the otp dropped when empty.
func encodeLogin(value loginValue) (string, error) {
	var out strings.Builder
	out.WriteString(`{"fields":[`)
	for index, entry := range value.Fields {
		// LoginField's transform: a visible value is trimmed, and one left empty is refused
		// ("Enter a value"). encodeLoginSecret parses every value through it, an older saved
		// pair included, so a legacy field is trimmed here too.
		if !entry.Hidden {
			entry.Value = validate.JSTrim(entry.Value)
			if entry.Value == "" {
				return "", badRequest(loginRefusal)
			}
		}
		if index > 0 {
			out.WriteByte(',')
		}
		out.WriteString(`{"label":`)
		wtf8.AppendQuoted(&out, entry.Label)
		out.WriteString(`,"value":`)
		wtf8.AppendQuoted(&out, entry.Value)
		out.WriteString(`,"hidden":`)
		out.WriteString(strconv.FormatBool(entry.Hidden))
		out.WriteByte('}')
	}
	out.WriteString(`]`)
	if value.OTP != nil && *value.OTP != "" {
		out.WriteString(`,"otp":`)
		wtf8.AppendQuoted(&out, *value.OTP)
	}
	out.WriteString(`}`)
	canonical := out.String()
	if wtf8.Length(canonical) > loginJSONMax {
		return "", badRequest(loginRefusal)
	}
	return canonical, nil
}

// decodeLogin is decodeLoginSecret (bot-secrets.ts:402-411) with LoginSecretValue's checks: a
// legacy username/password pair becomes two fields as stored, anything else must be a current
// login. A refusal names the authenticator key when any otp issue was found (readLoginValue,
// :807-813), because LoginSecretValue.parse reports the fields' and the key's issues together.
func decodeLogin(plaintext string) (loginValue, error) {
	value, err := validate.DecodeAny([]byte(plaintext))
	if err != nil {
		return loginValue{}, badRequest(loginRefusal)
	}
	if legacy := legacyLogin(value); legacy != nil {
		return *legacy, nil
	}
	object, ok := value.(*validate.Object)
	if !ok {
		return loginValue{}, badRequest(loginRefusal)
	}
	fields := loginValue{}
	fieldIssue := false
	rawFields, isArray := object.Values["fields"].([]any)
	if !isArray || len(rawFields) < 1 || len(rawFields) > loginFieldLimit {
		fieldIssue = true
	}
	labels := make(map[string]bool, len(rawFields))
	for _, raw := range rawFields {
		entry, isObject := raw.(*validate.Object)
		if !isObject {
			fieldIssue = true
			continue
		}
		labelText, isLabel := entry.Values["label"].(string)
		label := ""
		if isLabel {
			label = validate.JSTrim(labelText)
		}
		if !isLabel || !wtf8.Fits(label, 1, loginLabelMax) {
			fieldIssue = true
			continue
		}
		key := casesLower(label)
		if labels[key] {
			fieldIssue = true
			continue
		}
		labels[key] = true
		valueText, isValue := entry.Values["value"].(string)
		hidden, isHidden := entry.Values["hidden"].(bool)
		if !isValue || !isHidden || !wtf8.Fits(valueText, 0, loginValueMax) {
			fieldIssue = true
			continue
		}
		if !hidden {
			valueText = validate.JSTrim(valueText)
		}
		if valueText == "" {
			fieldIssue = true
			continue
		}
		fields.Fields = append(fields.Fields, loginField{Label: label, Value: valueText, Hidden: hidden})
	}
	otpIssue := false
	rawOTP, hasOTP := object.Get("otp")
	if hasOTP && rawOTP != nil {
		text, isText := rawOTP.(string)
		if !isText {
			otpIssue = true
		} else {
			trimmed := validate.JSTrim(text)
			if wtf8.Length(trimmed) > authenticatorMax {
				otpIssue = true
			} else if trimmed != "" && !vaultitems.ValidAuthenticatorKey(trimmed) {
				otpIssue = true
			}
			fields.OTP = &trimmed
		}
	}
	canonical, err := encodeLogin(fields)
	if err != nil {
		return loginValue{}, err
	}
	if wtf8.Length(canonical) > loginJSONMax {
		// LoginSecretValue's length refine reports at the root, so it is not an otp issue.
		fieldIssue = true
	}
	switch {
	case otpIssue:
		return loginValue{}, badRequest(unreadableKeyError)
	case fieldIssue:
		return loginValue{}, badRequest(loginRefusal)
	}
	return fields, nil
}

// legacyLogin is LegacyLoginSecretValue (bot-secrets.ts:392-398): an object with a username
// and password, read as two fields. Not strict, so other keys are ignored.
func legacyLogin(value any) *loginValue {
	object, ok := value.(*validate.Object)
	if !ok {
		return nil
	}
	username, hasUser := object.Values["username"].(string)
	password, hasPassword := object.Values["password"].(string)
	if !hasUser || !hasPassword ||
		!wtf8.Fits(username, 1, loginLegacyUser) || !wtf8.Fits(password, 1, loginLegacyPass) {
		return nil
	}
	// The values stay as the stored pair had them: a legacy row is never re-validated.
	return &loginValue{Fields: []loginField{
		{Label: loginFieldDefault, Value: username},
		{Label: "Password", Value: password, Hidden: true},
	}}
}

// cardValue is CardSecretValue (bot-secrets.ts:686-702), the shape a reveal returns.
type cardValue struct {
	Number   string  `json:"number"`
	ExpMonth int64   `json:"expMonth"`
	ExpYear  int64   `json:"expYear"`
	CVC      *string `json:"cvc,omitempty"`
	Name     *string `json:"name,omitempty"`
	Billing  *string `json:"billing,omitempty"`
}

// canonicalCard is encodeCardSecret (bot-secrets.ts:700-709).
func canonicalCard(plaintext string) (string, error) {
	card, err := decodeCard(plaintext)
	if err != nil {
		return "", err
	}
	return encodeCard(card)
}

// encodeCard is JSON.stringify(CardSecretValue.parse(value)): the six keys in schema order,
// empty cvc/name/billing dropped.
func encodeCard(card cardValue) (string, error) {
	var out strings.Builder
	out.WriteString(`{"number":`)
	wtf8.AppendQuoted(&out, card.Number)
	out.WriteString(`,"expMonth":` + strconv.FormatInt(card.ExpMonth, 10))
	out.WriteString(`,"expYear":` + strconv.FormatInt(card.ExpYear, 10))
	if card.CVC != nil && *card.CVC != "" {
		out.WriteString(`,"cvc":`)
		wtf8.AppendQuoted(&out, *card.CVC)
	}
	if card.Name != nil && *card.Name != "" {
		out.WriteString(`,"name":`)
		wtf8.AppendQuoted(&out, *card.Name)
	}
	if card.Billing != nil && *card.Billing != "" {
		out.WriteString(`,"billing":`)
		wtf8.AppendQuoted(&out, *card.Billing)
	}
	out.WriteString(`}`)
	return out.String(), nil
}

// decodeCard is CardSecretValue's parse: strict in its six keys, the number reduced to digits
// and Luhn-checked, an integer month and year, cvc trimmed or empty.
func decodeCard(plaintext string) (cardValue, error) {
	value, err := validate.DecodeAny([]byte(plaintext))
	if err != nil {
		return cardValue{}, badRequest(cardRefusal)
	}
	object, ok := value.(*validate.Object)
	if !ok {
		return cardValue{}, badRequest(cardRefusal)
	}
	allowed := map[string]bool{
		"number": true, "expMonth": true, "expYear": true, "cvc": true, "name": true, "billing": true,
	}
	for key := range object.Values {
		if !allowed[key] {
			return cardValue{}, badRequest(cardRefusal)
		}
	}
	numberText, ok := object.Values["number"].(string)
	if !ok {
		return cardValue{}, badRequest(cardRefusal)
	}
	number := strings.NewReplacer(" ", "", "-", "").Replace(numberText)
	if !cardDigits.MatchString(number) || !luhnValid(number) {
		return cardValue{}, badRequest(cardRefusal)
	}
	expMonth, ok := jsInteger(object.Values["expMonth"])
	if !ok || expMonth < 1 || expMonth > 12 {
		return cardValue{}, badRequest(cardRefusal)
	}
	expYear, ok := jsInteger(object.Values["expYear"])
	if !ok || expYear < 2000 || expYear > 2100 {
		return cardValue{}, badRequest(cardRefusal)
	}
	card := cardValue{Number: number, ExpMonth: expMonth, ExpYear: expYear}
	if raw, present := object.Get("cvc"); present && raw != nil {
		text, isText := raw.(string)
		if !isText {
			return cardValue{}, badRequest(cardRefusal)
		}
		trimmed := validate.JSTrim(text)
		if wtf8.Length(trimmed) > 4 || (trimmed != "" && !cardCVC.MatchString(trimmed)) {
			return cardValue{}, badRequest(cardRefusal)
		}
		if trimmed != "" {
			card.CVC = &trimmed
		}
	}
	name, ok := optionalText(object, "name", 200)
	if !ok {
		return cardValue{}, badRequest(cardRefusal)
	}
	if name != "" {
		card.Name = &name
	}
	billing, ok := optionalText(object, "billing", 64)
	if !ok || (billing != "" && !botSecretName.MatchString(billing)) {
		return cardValue{}, badRequest(cardRefusal)
	}
	if billing != "" {
		card.Billing = &billing
	}
	return card, nil
}

// contactKeys is ContactFields' shape order (bot-secrets.ts:646-659).
var contactKeys = []struct {
	key   string
	limit int
}{
	{"name", 200}, {"line1", 200}, {"line2", 200}, {"city", 100}, {"region", 100},
	{"postalCode", 20}, {"country", 100}, {"phone", 40}, {"email", 254},
}

// canonicalContact is encodeContactSecret (bot-secrets.ts:711-714): trimmed optional fields,
// at least one present, no other keys.
func canonicalContact(plaintext string) (string, error) {
	value, err := validate.DecodeAny([]byte(plaintext))
	if err != nil {
		return "", badRequest(contactRefusal)
	}
	object, ok := value.(*validate.Object)
	if !ok {
		return "", badRequest(contactRefusal)
	}
	known := map[string]bool{}
	for _, entry := range contactKeys {
		known[entry.key] = true
	}
	for key := range object.Values {
		if !known[key] {
			return "", badRequest(contactRefusal)
		}
	}
	var out strings.Builder
	out.WriteByte('{')
	written, anyValue := 0, false
	for _, entry := range contactKeys {
		text, ok := optionalText(object, entry.key, entry.limit)
		if !ok {
			return "", badRequest(contactRefusal)
		}
		if text == "" {
			continue
		}
		if written > 0 {
			out.WriteByte(',')
		}
		written++
		anyValue = true
		wtf8.AppendQuoted(&out, entry.key)
		out.WriteByte(':')
		wtf8.AppendQuoted(&out, text)
	}
	out.WriteByte('}')
	if !anyValue {
		return "", badRequest(contactRefusal)
	}
	return out.String(), nil
}

// optionalText is optionalText (bot-secrets.ts:628-636): trimmed text, or empty when absent.
func optionalText(object *validate.Object, key string, limit int) (string, bool) {
	raw, present := object.Get(key)
	if !present || raw == nil {
		return "", true
	}
	text, ok := raw.(string)
	if !ok {
		return "", false
	}
	text = validate.JSTrim(text)
	if wtf8.Length(text) > limit {
		return "", false
	}
	return text, true
}

// jsInteger is z.number().int(): a JSON number with no fractional part.
func jsInteger(raw any) (int64, bool) {
	number, ok := raw.(json.Number)
	if !ok {
		return 0, false
	}
	value, err := strconv.ParseFloat(number.String(), 64)
	if err != nil || value != float64(int64(value)) || value < -9007199254740991 || value > 9007199254740991 {
		return 0, false
	}
	return int64(value), true
}

func luhnValid(digits string) bool {
	sum := 0
	for index := range len(digits) {
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

// cardBrand is cardBrand (bot-secrets.ts:684-697).
func cardBrand(number string) string {
	digits := nonDigits.ReplaceAllString(number, "")
	for _, brand := range cardBrands {
		if brand.prefix.MatchString(digits) {
			return brand.name
		}
	}
	return "Card"
}

var nonDigits = regexp.MustCompile(`\D`)

var cardBrands = []struct {
	prefix *regexp.Regexp
	name   string
}{
	{regexp.MustCompile(`^4`), "Visa"},
	{regexp.MustCompile(`^(5[1-5]|222[1-9]|22[3-9]|2[3-6]|27[01]|2720)`), "Mastercard"},
	{regexp.MustCompile(`^3[47]`), "Amex"},
	{regexp.MustCompile(`^(6011|65|64[4-9]|622)`), "Discover"},
	{regexp.MustCompile(`^3(0[0-5]|[68])`), "Diners Club"},
	{regexp.MustCompile(`^35(2[89]|[3-8])`), "JCB"},
	{regexp.MustCompile(`^62`), "UnionPay"},
}

// cardTitle is cardTitle (bot-secrets.ts:884-886): "Visa ·· 4242".
func cardTitle(number string) string {
	return cardBrand(number) + " ·· " + number[len(number)-4:]
}

// pageURLOrigin is pageUrlOrigin (bot-secrets.ts:686-706).
func pageURLOrigin(value string, allowUserinfo bool, maxLength int) (string, bool) {
	if wtf8.Length(value) > maxLength {
		return "", false
	}
	parsed, err := whatwgurl.Parse(value)
	if err != nil {
		return "", false
	}
	if parsed.Protocol() != "https:" && parsed.Protocol() != "http:" {
		return "", false
	}
	if !allowUserinfo && (parsed.Username() != "" || parsed.Password() != "") {
		return "", false
	}
	return parsed.Origin(), true
}

// otherSiteOrigin is otherSiteOrigin (vault-items.ts:30-38): an HTTPS site a login may be
// saved for, or nothing.
func otherSiteOrigin(site string) (string, bool) {
	if wtf8.Length(site) > 2048 || !whatwgurl.CanParse(site) {
		return "", false
	}
	parsed, err := whatwgurl.Parse(site)
	if err != nil {
		return "", false
	}
	if parsed.Username() != "" || parsed.Password() != "" || strings.Contains(parsed.Hostname(), "*") {
		return "", false
	}
	return originOnly(parsed)
}

// originOnly is OneTimeCodeTarget.safeParse({origin: url.origin}) (bot-secrets.ts:256-257):
// the origin must pass botSecretOriginSchema without the private-HTTP opt-in.
func originOnly(parsed *whatwgurl.URL) (string, bool) {
	origin := parsed.Origin()
	if !validOrigin(origin, false) {
		return "", false
	}
	return origin, true
}
