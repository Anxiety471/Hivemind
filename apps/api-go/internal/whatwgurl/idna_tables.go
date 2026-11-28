package whatwgurl

//go:generate go run ./genidnatables

// The Go tables in idna_tables_gen.go are generated from the committed probe
// outputs in testdata.
//
// Regeneration order (the Node scripts are in apps/api-go/tools and must be run
// from the repository root with Node/ICU available):
//
//  1. node --experimental-strip-types apps/api-go/tools/idna-mapping-cases.mts
//     writes testdata/idna-mapping.json.gz and testdata/single-cp-host.json.gz.
//  2. node --experimental-strip-types apps/api-go/tools/idna-bidi-cases.mts
//     reads the mapping file and writes testdata/idna-bidi.json.gz.
//  3. node --experimental-strip-types apps/api-go/tools/fetch-ucd.mts
//     downloads Unicode 17.0.0 UnicodeData.txt and DerivedCombiningClass.txt
//     into testdata/ucd/17.0.0 (gitignored) and verifies their SHA-256
//     digests.
//  4. node --experimental-strip-types apps/api-go/tools/idna-context-cases.mts
//     probes every valid code point through the host parser for the effective
//     ContextJ joining classes, Virama set, and the combining marks ICU's
//     normalizer treats as starters, writing testdata/idna-context.json.gz.
//     Its default ucdDir is testdata/ucd/17.0.0; the UCD supplies only
//     candidate combining classes.
//  5. go generate ./internal/whatwgurl
//
// All decisions that affect behavior come from the running Node/ICU host
// parser. UCD Joining_Type data is deliberately not used: ICU's IDNA tables
// differ for code points such as U+08B5, and a UCD-derived table produces
// false accepts and false rejects for ContextJ.
