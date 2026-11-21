// Package modelcredentials ports models.credentials: the member's saved model connections with
// the settings their sealed secrets carry, and which one runs the main model.
//
// The parser is packages/adapters/src/models/model-secret.ts; a secret that does not parse is as
// unreadable as a corrupt one, so the row is listed without the fields it would have contributed.
package modelcredentials

import (
	"bytes"
	"encoding/json"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
)

const maxModelContextWindow = 2_147_483_647
const maxModelMaxTokens = maxModelContextWindow

var thinkingLevels = []string{"off", "minimal", "low", "medium", "high", "xhigh", "max"}

var apiProtocols = map[string]bool{
	"chat-completions": true, "responses": true, "anthropic-messages": true,
}

// headerNamePattern is ModelHeaderNameSchema's regex (model-headers.ts:25-30).
var headerNamePattern = regexp.MustCompile("^[\\t ]*[!#$%&'*+.^_`|~0-9A-Za-z-]+[\\t ]*$")

var reservedHeaders = map[string]bool{
	"authorization": true, "proxy-authorization": true, "cookie": true, "host": true,
	"content-length": true, "content-type": true, "transfer-encoding": true,
	"connection": true, "keep-alive": true, "upgrade": true, "te": true, "trailer": true,
	"expect": true,
}

// modelSettings is ModelSettingsSchema after parsing.
type modelSettings struct {
	ContextWindow      *int64
	MaxTokens          *int64
	Images             *bool
	MaxImagesPerPrompt *int64
	Reasoning          *bool
}

type cacheCapabilities struct {
	RetentionMs         *int64
	MinimumTokens       *int64
	Scope               string
	RetentionMode       *string
	InputCostPerMillion *float64
	ReadCostPerMillion  *float64
	WriteCostPerMillion *float64
}

// secret is StoredModelSecret after parsing.
type secret struct {
	Kind string // api_key | oauth | openai_compatible

	Key       string
	AccountID *string
	GatewayID *string
	ProjectID *string
	Region    *string

	ReconnectRequired bool

	BaseURL            string
	APIProtocol        *string
	Headers            map[string]string
	HeaderNames        []string
	APIKey             *string
	Reasoning          *bool
	ThinkingLevel      *string
	VisionModelIDs     []string
	EnabledModelIDs    []string
	MaxImagesPerPrompt *int64

	MaxTokens     *int64
	ContextWindow *int64
	Cache         *cacheCapabilities
	Models        map[string]modelSettings
}

var errCorruptSecret = errorString("Stored model credential is corrupt. Connect the provider again.")

type errorString string

func (e errorString) Error() string { return string(e) }

// parseModelSecret is parseModelSecret (model-secret.ts:132-236).
func parseModelSecret(plaintext string) (secret, error) {
	trimmed := trimJS(plaintext)
	if !strings.HasPrefix(trimmed, "{") {
		return secret{Kind: "api_key", Key: plaintext}, nil
	}
	var parsed map[string]any
	decoder := json.NewDecoder(bytes.NewReader([]byte(trimmed)))
	decoder.UseNumber()
	if err := decoder.Decode(&parsed); err != nil || parsed == nil {
		return secret{Kind: "api_key", Key: plaintext}, nil
	}
	switch parsed["kind"] {
	case "openai_compatible":
		baseURL, isString := parsed["baseUrl"].(string)
		if !isString || trimJS(baseURL) == "" {
			return secret{}, errCorruptSecret
		}
		parsedSecret := secret{Kind: "openai_compatible", BaseURL: trimJS(baseURL)}
		if raw, present := parsed["apiProtocol"]; present && raw != nil {
			value, ok := raw.(string)
			if !ok || !apiProtocols[value] {
				return secret{}, errCorruptSecret
			}
			parsedSecret.APIProtocol = &value
		}
		if raw, present := parsed["headers"]; present {
			headers, names, ok := parseHeaders(raw)
			if !ok {
				return secret{}, errCorruptSecret
			}
			parsedSecret.Headers, parsedSecret.HeaderNames = headers, names
		}
		if value, ok := parsed["apiKey"].(string); ok {
			parsedSecret.APIKey = &value
		}
		if raw, present := parsed["thinkingLevel"]; present {
			if raw == nil {
				parsedSecret.ThinkingLevel = nil
			} else if value, ok := raw.(string); ok && contains(thinkingLevels, value) {
				parsedSecret.ThinkingLevel = &value
			}
		}
		parsedSecret.MaxTokens = parsedMaxTokens(parsed["maxTokens"])
		parsedSecret.ContextWindow = parsedWindow(parsed["contextWindow"])
		parsedSecret.VisionModelIDs = parsedModelIDs(parsed["visionModelIds"])
		parsedSecret.EnabledModelIDs = parsedModelIDs(parsed["enabledModelIds"])
		parsedSecret.MaxImagesPerPrompt = parsedBounded(parsed["maxImagesPerPrompt"], 1, 1000)
		if value, ok := parsed["reasoning"].(bool); ok {
			parsedSecret.Reasoning = &value
		}
		parsedSecret.Cache = parsedCache(parsed["cacheCapabilities"])
		parsedSecret.Models = parsedModels(parsed["models"])
		return parsedSecret, nil
	case "api_key":
		key, ok := parsed["key"].(string)
		if !ok || key == "" {
			return secret{}, errCorruptSecret
		}
		parsedSecret := secret{Kind: "api_key", Key: key}
		parsedSecret.MaxTokens = parsedMaxTokens(parsed["maxTokens"])
		parsedSecret.AccountID = routingID(parsed["accountId"])
		parsedSecret.GatewayID = routingID(parsed["gatewayId"])
		parsedSecret.ProjectID = routingID(parsed["projectId"])
		parsedSecret.Region = routingID(parsed["region"])
		parsedSecret.Cache = parsedCache(parsed["cacheCapabilities"])
		parsedSecret.ContextWindow = parsedWindow(parsed["contextWindow"])
		parsedSecret.Models = parsedModels(parsed["models"])
		return parsedSecret, nil
	case "oauth":
		parsedSecret := secret{Kind: "oauth"}
		parsedSecret.MaxTokens = parsedMaxTokens(parsed["maxTokens"])
		parsedSecret.Models = parsedModels(parsed["models"])
		if reconnect, _ := parsed["reconnectRequired"].(bool); reconnect {
			parsedSecret.ReconnectRequired = true
			return parsedSecret, nil
		}
		if !validOAuthCredential(parsed["credential"]) {
			return secret{}, errCorruptSecret
		}
		return parsedSecret, nil
	}
	// Legacy secrets serialize the bare OAuth credential.
	if parsed["type"] == "oauth" {
		if !validOAuthCredential(parsed) {
			return secret{}, errCorruptSecret
		}
		return secret{Kind: "oauth"}, nil
	}
	return secret{Kind: "api_key", Key: plaintext}, nil
}

func validOAuthCredential(value any) bool {
	record, ok := value.(map[string]any)
	if !ok {
		return false
	}
	if record["type"] != "oauth" {
		return false
	}
	_, access := record["access"].(string)
	_, refresh := record["refresh"].(string)
	_, expires := record["expires"].(json.Number)
	return access && refresh && expires
}

func routingID(value any) *string {
	text, ok := value.(string)
	if !ok {
		return nil
	}
	trimmed := trimJS(text)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

func parsedMaxTokens(value any) *int64 { return parsedBounded(value, 1, maxModelMaxTokens) }

func parsedWindow(value any) *int64 { return parsedBounded(value, 1, maxModelContextWindow) }

func parsedBounded(value any, minimum, maximum int64) *int64 {
	number, ok := value.(json.Number)
	if !ok {
		return nil
	}
	integer, err := number.Int64()
	if err != nil || integer < minimum || integer > maximum {
		return nil
	}
	return &integer
}

func parsedModelIDs(value any) []string {
	items, ok := value.([]any)
	if !ok {
		return nil
	}
	ids := make([]string, 0, len(items))
	for _, item := range items {
		if text, ok := item.(string); ok && trimJS(text) != "" {
			ids = append(ids, text)
		}
	}
	return ids
}

func parsedCache(value any) *cacheCapabilities {
	record, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	cache := &cacheCapabilities{}
	if number, ok := record["retentionMs"].(json.Number); ok {
		if integer, err := number.Int64(); err == nil && integer > 0 && integer <= 2_147_483_647 {
			cache.RetentionMs = &integer
		}
	}
	if number, ok := record["minimumTokens"].(json.Number); ok {
		if integer, err := number.Int64(); err == nil && integer >= 0 && integer <= 2_147_483_647 {
			cache.MinimumTokens = &integer
		}
	}
	scope, _ := record["scope"].(string)
	if scope != "account" && scope != "connection" {
		return nil
	}
	cache.Scope = scope
	if mode, ok := record["retentionMode"].(string); ok {
		if mode == "none" || mode == "short" || mode == "long" {
			cache.RetentionMode = &mode
		}
	}
	nonNegative := func(key string) *float64 {
		number, ok := record[key].(json.Number)
		if !ok {
			return nil
		}
		value, err := number.Float64()
		if err != nil || value < 0 {
			return nil
		}
		return &value
	}
	cache.InputCostPerMillion = nonNegative("inputCostPerMillion")
	cache.ReadCostPerMillion = nonNegative("readCostPerMillion")
	cache.WriteCostPerMillion = nonNegative("writeCostPerMillion")
	return cache
}

func parsedModels(value any) map[string]modelSettings {
	record, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	models := map[string]modelSettings{}
	for id, raw := range record {
		settings, ok := parseModelSettings(raw)
		if trimJS(id) != "" && ok {
			models[id] = settings
		}
	}
	if len(models) == 0 {
		return nil
	}
	return models
}

func parseModelSettings(value any) (modelSettings, bool) {
	record, ok := value.(map[string]any)
	if !ok {
		// A settings entry that is not an object fails ModelSettingsSchema and is dropped.
		return modelSettings{}, false
	}
	settings := modelSettings{
		ContextWindow:      parsedWindow(record["contextWindow"]),
		MaxTokens:          parsedMaxTokens(record["maxTokens"]),
		MaxImagesPerPrompt: parsedBounded(record["maxImagesPerPrompt"], 1, 1000),
	}
	if raw, present := record["images"]; present {
		flag, ok := raw.(bool)
		if !ok {
			return modelSettings{}, false
		}
		settings.Images = &flag
	}
	if raw, present := record["reasoning"]; present {
		flag, ok := raw.(bool)
		if !ok {
			return modelSettings{}, false
		}
		settings.Reasoning = &flag
	}
	// modelOutputLeavesInputRoom.
	if settings.MaxTokens != nil && settings.ContextWindow != nil && *settings.MaxTokens >= *settings.ContextWindow {
		return modelSettings{}, false
	}
	return settings, true
}

// parseHeaders is parseModelHeaders: at most eight unique names, trimmed, values printable ASCII.
func parseHeaders(value any) (map[string]string, []string, bool) {
	record, ok := value.(map[string]any)
	if !ok {
		return nil, nil, false
	}
	if len(record) > 8 {
		return nil, nil, false
	}
	// Order comes from the JSON document, not the map.
	names := orderedObjectKeys(value)
	if names == nil {
		return nil, nil, false
	}
	headers := map[string]string{}
	trimmedNames := make([]string, 0, len(names))
	seen := map[string]bool{}
	for _, rawName := range names {
		raw, _ := record[rawName]
		headerValue, ok := raw.(string)
		if !ok || len(headerValue) < 1 || len(headerValue) > 1024 {
			return nil, nil, false
		}
		for _, character := range headerValue {
			if character < 0x20 || character > 0x7e {
				return nil, nil, false
			}
		}
		if !headerNamePattern.MatchString(rawName) || utf16Len(rawName) > 256 {
			return nil, nil, false
		}
		name := trimJS(rawName)
		lower := strings.ToLower(name)
		if reservedHeaders[lower] || strings.HasPrefix(lower, "proxy-") || strings.HasPrefix(lower, "sec-") {
			return nil, nil, false
		}
		if seen[lower] {
			return nil, nil, false
		}
		seen[lower] = true
		headers[name] = headerValue
		trimmedNames = append(trimmedNames, name)
	}
	return headers, trimmedNames, true
}

// orderedObjectKeys reads a decoded object's keys in document order.
func orderedObjectKeys(value any) []string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil
	}
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	token, err := decoder.Token()
	if err != nil {
		return nil
	}
	if delimiter, ok := token.(json.Delim); !ok || delimiter != '{' {
		return nil
	}
	keys := []string{}
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return nil
		}
		key, ok := token.(string)
		if !ok {
			return nil
		}
		var skip json.RawMessage
		if err := decoder.Decode(&skip); err != nil {
			return nil
		}
		keys = append(keys, key)
	}
	return jsKeyOrder(keys)
}

// jsKeyOrder is Object.keys' order: array-index keys ascending first, then insertion order.
func jsKeyOrder(keys []string) []string {
	indices := []string{}
	others := []string{}
	for _, key := range keys {
		if isArrayIndex(key) {
			indices = append(indices, key)
		} else {
			others = append(others, key)
		}
	}
	sort.SliceStable(indices, func(left, right int) bool {
		a, _ := strconv.ParseUint(indices[left], 10, 64)
		b, _ := strconv.ParseUint(indices[right], 10, 64)
		return a < b
	})
	return append(indices, others...)
}

func isArrayIndex(key string) bool {
	if key == "" || (len(key) > 1 && key[0] == '0') {
		return false
	}
	value, err := strconv.ParseUint(key, 10, 64)
	if err != nil || value > 4294967294 {
		return false
	}
	return strconv.FormatUint(value, 10) == key
}

func contains(values []string, value string) bool {
	for _, candidate := range values {
		if candidate == value {
			return true
		}
	}
	return false
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

func usableModelID(value string) (string, bool) {
	trimmed := trimJS(value)
	return trimmed, trimmed != ""
}

func utf16Len(value string) int { return len(utf16.Encode([]rune(value))) }
