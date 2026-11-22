package filepolicy

import (
	"bytes"
	"errors"
	"fmt"
	"mime"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"
)

const (
	// LegacyAttachmentMaxBytes is the default per-attachment base64 RPC cap (10 MiB).
	LegacyAttachmentMaxBytes = 10 * 1024 * 1024
	// DefaultFileUploadMaxBytes is the default streaming Space Drive upload limit (250 MiB).
	DefaultFileUploadMaxBytes = 250 * 1024 * 1024
	// FileUploadMaxCeilingBytes caps MAX_FILE_UPLOAD_SIZE_MB (2000 MiB).
	FileUploadMaxCeilingBytes = 2000 * 1024 * 1024
	// SandboxAutoMaterializeMaxBytes skips automatic workspace copying above 25 MiB.
	SandboxAutoMaterializeMaxBytes = 25 * 1024 * 1024
)

// ValidationError signals a caller-fixable upload, MIME, or naming violation.
type ValidationError struct {
	Message string
}

func (e *ValidationError) Error() string { return e.Message }

var mimeSyntaxPattern = regexp.MustCompile(`^[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+$`)

var blockedExtensions = map[string]bool{
	".exe": true, ".dll": true, ".msi": true, ".msp": true, ".mst": true,
	".scr": true, ".com": true, ".pif": true, ".cpl": true, ".hta": true,
	".sys": true, ".drv": true, ".ocx": true, ".vxd": true,
}

var blockedMIMETypes = map[string]bool{
	"application/x-msdownload":                   true,
	"application/x-ms-installer":                 true,
	"application/x-msi":                          true,
	"application/vnd.microsoft.portable-executable": true,
	"application/x-dosexec":                      true,
	"application/x-executable":                   true,
}

var compoundExtensions = []string{".tar.gz", ".tar.bz2", ".tar.xz"}

var extensionMIMETypes = map[string]string{
	// Audio
	".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".oga": "audio/ogg",
	".m4a": "audio/mp4", ".flac": "audio/flac", ".aac": "audio/aac", ".weba": "audio/webm",
	// Video
	".mp4": "video/mp4", ".m4v": "video/x-m4v", ".mov": "video/quicktime",
	".webm": "video/webm", ".mkv": "video/x-matroska", ".ogv": "video/ogg",
	// Images
	".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
	".gif": "image/gif", ".avif": "image/avif", ".heic": "image/heic", ".heif": "image/heif",
	".svg": "image/svg+xml", ".ico": "image/x-icon",
	// Documents
	".pdf": "application/pdf",
	".doc": "application/msword",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".xls":  "application/vnd.ms-excel",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".ppt":  "application/vnd.ms-powerpoint",
	".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	".rtf":  "application/rtf",
	".odt":  "application/vnd.oasis.opendocument.text",
	".ods":  "application/vnd.oasis.opendocument.spreadsheet",
	// Text & config
	".txt": "text/plain", ".log": "text/plain", ".env": "text/plain",
	".ini": "text/plain", ".conf": "text/plain", ".cfg": "text/plain",
	".md": "text/markdown", ".markdown": "text/markdown",
	".csv": "text/csv", ".tsv": "text/tab-separated-values",
	// Code & scripts
	".html": "text/html", ".htm": "text/html", ".css": "text/css",
	".json": "application/json", ".xml": "application/xml",
	".yaml": "application/yaml", ".yml": "application/yaml",
	".toml": "application/toml", ".sql": "application/sql",
	".sh": "application/x-sh", ".bash": "application/x-sh",
	".zsh": "application/x-sh", ".fish": "application/x-sh",
	".js": "application/javascript", ".mjs": "application/javascript",
	".cjs": "application/javascript", ".jsx": "application/javascript",
	".ts": "text/typescript", ".mts": "text/typescript", ".cts": "text/typescript", ".tsx": "text/typescript",
	".py": "text/x-python", ".go": "text/x-go", ".rs": "text/x-rust",
	".c": "text/x-c", ".h": "text/x-c", ".cpp": "text/x-c++", ".hpp": "text/x-c++", ".cc": "text/x-c++",
	".java": "text/x-java", ".rb": "text/x-ruby", ".php": "application/x-httpd-php",
	".swift": "text/x-swift", ".kt": "text/x-kotlin",
	".diff": "text/x-diff", ".patch": "text/x-diff",
	// Archives
	".zip": "application/zip", ".rar": "application/vnd.rar", ".7z": "application/x-7z-compressed",
	".gz": "application/gzip", ".tgz": "application/gzip", ".tar.gz": "application/gzip",
	".tar": "application/x-tar",
	".bz2": "application/x-bzip2", ".tar.bz2": "application/x-bzip2",
	".xz": "application/x-xz", ".tar.xz": "application/x-xz",
}

var mimeAliases = map[string]string{
	"application/x-zip-compressed": "application/zip",
	"application/x-zip":            "application/zip",
	"multipart/x-zip":              "application/zip",
	"application/x-rar-compressed": "application/vnd.rar",
	"application/x-rar":            "application/vnd.rar",
	"application/rar":              "application/vnd.rar",
	"application/x-7z":             "application/x-7z-compressed",
	"application/x-gzip":           "application/gzip",
	"audio/mp3":                    "audio/mpeg",
	"audio/x-wav":                  "audio/wav",
	"audio/wave":                   "audio/wav",
	"audio/vnd.wave":               "audio/wav",
	"audio/x-m4a":                  "audio/mp4",
	"audio/m4a":                    "audio/mp4",
	"audio/x-flac":                 "audio/flac",
	"text/x-sh":                    "application/x-sh",
	"text/x-shellscript":           "application/x-sh",
	"application/x-shellscript":    "application/x-sh",
	"application/x-yaml":           "application/yaml",
	"text/yaml":                    "application/yaml",
	"text/x-yaml":                  "application/yaml",
	"text/javascript":              "application/javascript",
	"application/x-javascript":     "application/javascript",
	"application/typescript":       "text/typescript",
	"text/x-typescript":            "text/typescript",
	"application/x-python":         "text/x-python",
	"text/x-python-script":         "text/x-python",
	"application/x-sql":            "application/sql",
	"text/x-sql":                   "application/sql",
	"text/xml":                     "application/xml",
	"video/x-quicktime":            "video/quicktime",
}

var explicitAllowedMIMEs = map[string]bool{
	"image/jpeg": true, "image/png": true, "image/webp": true, "image/gif": true,
	"image/avif": true, "image/heic": true, "image/heif": true, "image/svg+xml": true, "image/x-icon": true,
	"video/mp4": true, "video/x-m4v": true, "video/quicktime": true, "video/webm": true, "video/x-matroska": true, "video/ogg": true,
	"audio/mpeg": true, "audio/wav": true, "audio/ogg": true, "audio/mp4": true, "audio/webm": true, "audio/flac": true, "audio/aac": true,
	"application/zip": true, "application/vnd.rar": true, "application/x-7z-compressed": true,
	"application/gzip": true, "application/x-tar": true, "application/x-bzip2": true, "application/x-xz": true,
	"application/x-sh": true, "application/javascript": true, "application/json": true, "application/xml": true,
	"application/yaml": true, "application/toml": true, "application/sql": true, "application/x-httpd-php": true,
	"text/html": true, "text/css": true, "text/typescript": true,
	"text/x-python": true, "text/x-go": true, "text/x-rust": true, "text/x-c": true, "text/x-c++": true,
	"text/x-java": true, "text/x-ruby": true, "text/x-swift": true, "text/x-kotlin": true, "text/x-diff": true,
	"application/pdf": true, "application/msword": true,
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document": true,
	"application/vnd.ms-excel": true,
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": true,
	"application/vnd.ms-powerpoint": true,
	"application/vnd.openxmlformats-officedocument.presentationml.presentation": true,
	"application/rtf": true, "application/vnd.oasis.opendocument.text": true, "application/vnd.oasis.opendocument.spreadsheet": true,
	"text/plain": true, "text/markdown": true, "text/csv": true, "text/tab-separated-values": true,
	"application/octet-stream": true,
}

var codeMIMETypes = map[string]bool{
	"application/x-sh": true, "application/javascript": true, "application/json": true, "application/xml": true,
	"application/yaml": true, "application/toml": true, "application/sql": true, "application/x-httpd-php": true,
	"text/html": true, "text/css": true, "text/typescript": true,
	"text/x-python": true, "text/x-go": true, "text/x-rust": true, "text/x-c": true, "text/x-c++": true,
	"text/x-java": true, "text/x-ruby": true, "text/x-swift": true, "text/x-kotlin": true, "text/x-diff": true,
}

var documentMIMETypes = map[string]bool{
	"application/pdf": true, "application/msword": true,
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document": true,
	"application/vnd.ms-excel": true,
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": true,
	"application/vnd.ms-powerpoint": true,
	"application/vnd.openxmlformats-officedocument.presentationml.presentation": true,
	"application/rtf": true, "application/vnd.oasis.opendocument.text": true, "application/vnd.oasis.opendocument.spreadsheet": true,
	"text/plain": true, "text/markdown": true, "text/csv": true, "text/tab-separated-values": true,
}

// NormalizeMIME strips MIME parameters and lowercases the type/subtype.
func NormalizeMIME(mimeType string) string {
	base, _, _ := strings.Cut(mimeType, ";")
	return strings.ToLower(strings.TrimSpace(base))
}

func fileExtensionLower(name string) string {
	lower := strings.ToLower(strings.TrimSpace(name))
	for _, c := range compoundExtensions {
		if strings.HasSuffix(lower, c) {
			return c
		}
	}
	return strings.ToLower(filepath.Ext(lower))
}

// IsBlockedExtension checks for executable dropper extensions regardless of case.
func IsBlockedExtension(name string) bool {
	return blockedExtensions[fileExtensionLower(name)]
}

// IsBlockedMIME reports whether a MIME type represents an executable binary dropper.
func IsBlockedMIME(mimeType string) bool {
	return blockedMIMETypes[NormalizeMIME(mimeType)]
}

// IsAllowedMIME reports whether normalized mimeType is accepted for Space uploads.
func IsAllowedMIME(mimeType string) bool {
	n := NormalizeMIME(mimeType)
	if n == "" || !mimeSyntaxPattern.MatchString(n) || blockedMIMETypes[n] {
		return false
	}
	if explicitAllowedMIMEs[n] {
		return true
	}
	return strings.HasPrefix(n, "text/") ||
		strings.HasPrefix(n, "image/") ||
		strings.HasPrefix(n, "audio/") ||
		strings.HasPrefix(n, "video/")
}

// ValidateMIME validates an explicit MIME type without inferring from a filename.
func ValidateMIME(mimeType string) (string, error) {
	n := NormalizeMIME(mimeType)
	if alias, ok := mimeAliases[n]; ok {
		n = alias
	}
	if !IsAllowedMIME(n) {
		return "", &ValidationError{Message: fmt.Sprintf("File type %q is not supported", mimeType)}
	}
	return n, nil
}

// InferMIME validates and canonicalizes a file's MIME type from its name and reported MIME.
func InferMIME(name, reportedType string) (string, error) {
	if IsBlockedExtension(name) {
		return "", &ValidationError{Message: "Executable installer or binary file types are not permitted"}
	}
	rawReported := NormalizeMIME(reportedType)
	if rawReported != "" {
		if !mimeSyntaxPattern.MatchString(rawReported) {
			return "", &ValidationError{Message: fmt.Sprintf("Invalid MIME type %q", reportedType)}
		}
		if IsBlockedMIME(rawReported) {
			return "", &ValidationError{Message: "Executable binary file types are not permitted"}
		}
	}
	normalized := rawReported
	if alias, ok := mimeAliases[rawReported]; ok {
		normalized = alias
	}
	extType := extensionMIMETypes[fileExtensionLower(name)]
	if extType != "" {
		if normalized == "" || normalized == "application/octet-stream" {
			return extType, nil
		}
		if normalized == "text/plain" && (strings.HasPrefix(extType, "text/") || codeMIMETypes[extType]) {
			return extType, nil
		}
		if extType == "text/csv" && normalized == "application/vnd.ms-excel" {
			return extType, nil
		}
		if extType == "audio/mp4" && normalized == "audio/aac" {
			return extType, nil
		}
	}
	if normalized != "" && IsAllowedMIME(normalized) {
		return normalized, nil
	}
	if extType != "" {
		return extType, nil
	}
	return "application/octet-stream", nil
}

// SniffSafeUpload rejects spoofed raster images / PDFs whose bytes don't match
// their claimed header, and blocks active HTML/SVG payloads disguised under
// safe media MIME types.
func SniffSafeUpload(claimedMIME string, prefix []byte) error {
	m := NormalizeMIME(claimedMIME)
	if m == "" {
		return nil
	}
	switch m {
	case "image/jpeg":
		if len(prefix) < 3 || prefix[0] != 0xff || prefix[1] != 0xd8 || prefix[2] != 0xff {
			return &ValidationError{Message: "File contents do not match JPEG header"}
		}
	case "image/png":
		pngMagic := []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a}
		if len(prefix) < len(pngMagic) || !bytes.Equal(prefix[:len(pngMagic)], pngMagic) {
			return &ValidationError{Message: "File contents do not match PNG header"}
		}
	case "image/gif":
		if len(prefix) < 6 || (!bytes.HasPrefix(prefix, []byte("GIF87a")) && !bytes.HasPrefix(prefix, []byte("GIF89a"))) {
			return &ValidationError{Message: "File contents do not match GIF header"}
		}
	case "image/webp":
		if len(prefix) < 12 || !bytes.Equal(prefix[:4], []byte("RIFF")) || !bytes.Equal(prefix[8:12], []byte("WEBP")) {
			return &ValidationError{Message: "File contents do not match WebP header"}
		}
	case "application/pdf":
		trimmed := bytes.TrimLeft(prefix, " \t\r\n")
		if !bytes.Contains(trimmed, []byte("%PDF-")) {
			return &ValidationError{Message: "File contents do not match PDF header"}
		}
	}

	// Guard safe raster/audio/video/pdf media types against HTML/SVG script polyglots.
	if strings.HasPrefix(m, "video/") || strings.HasPrefix(m, "audio/") || (strings.HasPrefix(m, "image/") && m != "image/svg+xml") || m == "application/pdf" {
		sample := strings.ToLower(string(bytes.TrimLeft(prefix, " \t\r\n\xef\xbb\xbf")))
		if strings.HasPrefix(sample, "<!doctype html") ||
			strings.HasPrefix(sample, "<html") ||
			strings.HasPrefix(sample, "<script") ||
			strings.HasPrefix(sample, "<svg") {
			return &ValidationError{Message: "Media file contents cannot start with active HTML or SVG markup"}
		}
	}
	return nil
}

// ValidateDriveName validates and normalizes a Space Drive file or folder name.
func ValidateDriveName(name string) (string, error) {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" || utf8.RuneCountInString(trimmed) > 255 || trimmed == "." || trimmed == ".." {
		return "", &ValidationError{Message: "Invalid file or folder name"}
	}
	for i := 0; i < len(trimmed); i++ {
		c := trimmed[i]
		if c == '/' || c == '\\' || c < 0x20 || c == 0x7f {
			return "", &ValidationError{Message: "File or folder name cannot contain slashes or control characters"}
		}
	}
	return trimmed, nil
}

// CategoryForMIME classifies a MIME type into one of the Space Drive category facets.
func CategoryForMIME(mimeType string) string {
	m := NormalizeMIME(mimeType)
	if strings.HasPrefix(m, "video/") {
		return "video"
	}
	if strings.HasPrefix(m, "image/") {
		return "image"
	}
	if strings.HasPrefix(m, "audio/") {
		return "audio"
	}
	switch m {
	case "application/zip", "application/vnd.rar", "application/x-7z-compressed",
		"application/gzip", "application/x-tar", "application/x-bzip2", "application/x-xz":
		return "archive"
	}
	if codeMIMETypes[m] {
		return "code"
	}
	if documentMIMETypes[m] || strings.HasPrefix(m, "text/") {
		return "document"
	}
	return "other"
}

// IsSafeInlineMedia determines whether direct browser viewing on the API origin
// can safely render inline (true) or must force Content-Disposition: attachment
// (false, e.g., text/html, image/svg+xml, active script content).
func IsSafeInlineMedia(mimeType string) bool {
	m := NormalizeMIME(mimeType)
	if m == "image/svg+xml" || m == "text/html" || m == "application/xhtml+xml" || m == "application/xml" || m == "application/javascript" {
		return false
	}
	if strings.HasPrefix(m, "image/") || strings.HasPrefix(m, "video/") || strings.HasPrefix(m, "audio/") {
		return true
	}
	switch m {
	case "application/pdf", "text/plain", "text/markdown", "text/csv", "text/tab-separated-values":
		return true
	}
	return false
}

// FormatContentDisposition builds a safe Content-Disposition header value.
func FormatContentDisposition(inline bool, filename string) string {
	kind := "attachment"
	if inline {
		kind = "inline"
	}
	clean := strings.TrimSpace(filename)
	if clean == "" {
		clean = "file"
	}
	clean = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f || r == '/' || r == '\\' {
			return '_'
		}
		return r
	}, clean)
	return mime.FormatMediaType(kind, map[string]string{"filename": clean})
}

// IsValidationError reports whether err is a caller-fixable ValidationError.
func IsValidationError(err error) bool {
	var target *ValidationError
	return errors.As(err, &target)
}
