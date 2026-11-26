// Command genzones rebuilds the zoneinfo.zip that package tz embeds, from the
// IANA tzdata release production Node carries.
//
// The gateway must read exactly the tz database that production Node's ICU
// reads, never the host's /usr/share/zoneinfo: the host's tzdata package moves
// independently of Node (2026f extended Cuba's DST to 2027-11-07, while Node's
// ICU 78.3 still ends it on 2026-11-01), and a spending period computed from
// the wrong rule is a wrong billing boundary.
//
// Run it from apps/api-go with the production Node on PATH:
//
//	go generate ./internal/tz
//
// It downloads the two official releases (data.iana.org), verifies their
// SHA-256, builds the release's zic with the system C compiler, compiles the
// zones with -b fat so every transition through 2037 is explicit, and writes
// zoneinfo.zip, tzdata_gen.go and testdata/zone-names.json. The generated
// consts pin the tzdata release, the Node and ICU that read it, and the digest
// of the zip, so an upgrade of Node or of the tzdata pins fails
// TestNodeVersionProvenance until this command runs again.
package main

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/flate"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"go/format"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// The release production Node 24.22.3 carries (process.versions.tz) and the
// digests of its official tarballs. Change all three together.
const (
	tzdataVersion = "2026e"
	tzdataSHA256  = "b26882805f26aac59d5b222978e6580484b834ccdc98be89df2f05a6dc53a652"
	tzcodeSHA256  = "cc3d27ca2a0d8399504551b920970d80af83bfb9c216e8082a15491921935d54"
	releaseBase   = "https://data.iana.org/time-zones/releases"
)

// historyVersion and historySHA256 pin an older tzdata release used only as a
// name source: it is where links tzdata dropped since (US/Pacific-New,
// Canada/East-Saskatchewan) are still listed. The short System V ids ICU keeps
// were never tzdata names in any release, so alias discovery also probes every
// two-, three- and four-letter id.
const (
	historyVersion = "2018g"
	historySHA256  = "02dfde534872f6513ae4553a3388fdae579441e31b862ea99170dfc447f46a16"
)

// zicSourceFiles are the tzdata files zic compiles; posixrules and the
// rearguard variant are not needed. systemv is absent from recent releases.
var zicSourceFiles = []string{
	"africa", "antarctica", "asia", "australasia", "europe",
	"northamerica", "southamerica", "etcetera", "backward", "factory",
}

func main() {
	tzdataPath := flag.String("tzdata", "", "local tzdata"+tzdataVersion+".tar.gz (downloaded when empty)")
	tzcodePath := flag.String("tzcode", "", "local tzcode"+tzdataVersion+".tar.gz (downloaded when empty)")
	nodePath := flag.String("node", "", "production node binary (default: ~/.local/opt/node24/bin/node, then PATH)")
	historyPath := flag.String("history", "", "local tzdata"+historyVersion+".tar.gz name source (downloaded when empty)")
	outDir := flag.String("out", ".", "package directory to write into")
	flag.Parse()

	data := fetch(*tzdataPath, "tzdata"+tzdataVersion+".tar.gz", tzdataSHA256)
	code := fetch(*tzcodePath, "tzcode"+tzdataVersion+".tar.gz", tzcodeSHA256)
	history := fetch(*historyPath, "tzdata"+historyVersion+".tar.gz", historySHA256)
	node := *nodePath
	if node == "" {
		node = productionNode()
	}

	temp, err := os.MkdirTemp("", "genzones-")
	if err != nil {
		fatal(err)
	}
	defer os.RemoveAll(temp)

	writeSources(temp, data, code)
	zic := buildZic(temp)
	zones := filepath.Join(temp, "zoneinfo")
	run(zic, append([]string{"-b", "fat", "-d", zones}, dataFiles(temp)...)...)

	candidates := candidateNames(temp, history)
	aliases, selfNamed := installAliases(temp, zones, node, candidates)
	names, digest := writeZip(zones, filepath.Join(*outDir, "zoneinfo.zip"))
	versions := nodeVersions(node)
	writePackage(*outDir, names, digest, versions, aliases, selfNamed)
	fmt.Printf("tz %s: %d zones, zoneinfo.zip %s, node %s icu %s, %d ICU-only ids\n",
		tzdataVersion, len(names), digest, versions.Node, versions.ICU, len(aliases))
}

// fetch returns the release tarball, downloading it when path is empty, and
// refuses anything whose digest is not the pinned one.
func fetch(path, name, want string) []byte {
	if path == "" {
		url := releaseBase + "/" + name
		client := &http.Client{Timeout: 2 * time.Minute}
		response, err := client.Get(url)
		if err != nil {
			fatalf("download %s: %v", url, err)
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusOK {
			fatalf("download %s: %s", url, response.Status)
		}
		body, err := io.ReadAll(response.Body)
		if err != nil {
			fatalf("read %s: %v", url, err)
		}
		fmt.Printf("downloaded %s (%d bytes)\n", url, len(body))
		return verify(name, body, want)
	}
	body, err := os.ReadFile(path)
	if err != nil {
		fatalf("read %s: %v", path, err)
	}
	return verify(name, body, want)
}

func verify(name string, body []byte, want string) []byte {
	got := sha256.Sum256(body)
	if hex.EncodeToString(got[:]) != want {
		fatalf("%s sha256 is %s, the pin is %s: refusing to generate from an unpinned release",
			name, hex.EncodeToString(got[:]), want)
	}
	return body
}

// productionNode is the Node the gateway's TypeScript side runs on; its ICU
// carries the zone data this generator must reproduce.
func productionNode() string {
	if home, err := os.UserHomeDir(); err == nil {
		path := filepath.Join(home, ".local", "opt", "node24", "bin", "node")
		if _, err := os.Stat(path); err == nil {
			return path
		}
	}
	path, err := exec.LookPath("node")
	if err != nil {
		fatalf("no node found: pass -node or install ~/.local/opt/node24/bin/node")
	}
	return path
}

type nodeVersionSet struct {
	Node string `json:"node"`
	ICU  string `json:"icu"`
	TZ   string `json:"tz"`
}

// nodeVersions reads process.versions from the production node, and refuses a
// tz version that is not the release this generator compiles.
func nodeVersions(node string) nodeVersionSet {
	out := run(node, "-p", "JSON.stringify(process.versions)")
	var versions nodeVersionSet
	if err := json.Unmarshal(out, &versions); err != nil {
		fatalf("parse process.versions from %s: %v", node, err)
	}
	if versions.TZ != tzdataVersion {
		fatalf("%s reports tz %s, this generator pins tzdata %s: pin the release Node actually carries",
			node, versions.TZ, tzdataVersion)
	}
	return versions
}

// writeSources unpacks the two tarballs into temp and gives zic the version
// header its Makefile would generate.
func writeSources(temp string, tzdata, tzcode []byte) {
	for _, entry := range []struct {
		name string
		body []byte
	}{{"tzdata", tzdata}, {"tzcode", tzcode}} {
		unpacked, err := gzip.NewReader(bytes.NewReader(entry.body))
		if err != nil {
			fatalf("gunzip %s: %v", entry.name, err)
		}
		reader := tar.NewReader(unpacked)
		for {
			header, err := reader.Next()
			if err == io.EOF {
				break
			}
			if err != nil {
				fatalf("unpack %s: %v", entry.name, err)
			}
			if header.Typeflag != tar.TypeReg || strings.Contains(header.Name, "/") {
				continue
			}
			body, err := io.ReadAll(reader)
			if err != nil {
				fatalf("unpack %s/%s: %v", entry.name, header.Name, err)
			}
			path := filepath.Join(temp, header.Name)
			if err := os.WriteFile(path, body, 0o644); err != nil {
				fatal(err)
			}
		}
	}
	version := fmt.Sprintf("static char const PKGVERSION[]=\"(tzcode) \";\nstatic char const TZVERSION[]=%q;\nstatic char const REPORT_BUGS_TO[]=\"<https://www.iana.org/time-zones>\";\n", tzdataVersion)
	if err := os.WriteFile(filepath.Join(temp, "version.h"), []byte(version), 0o644); err != nil {
		fatal(err)
	}
	// zic.c includes tzdir.h, which the release's Makefile also generates.
	tzdir := "#ifndef TZDEFAULT\n# define TZDEFAULT \"/etc/localtime\" /* default zone */\n#endif\n" +
		"#ifndef TZDIR\n# define TZDIR \"/usr/share/zoneinfo\" /* TZif directory */\n#endif\n"
	if err := os.WriteFile(filepath.Join(temp, "tzdir.h"), []byte(tzdir), 0o644); err != nil {
		fatal(err)
	}
}

func buildZic(temp string) string {
	for _, need := range []string{"zic.c", "version.h"} {
		if _, err := os.Stat(filepath.Join(temp, need)); err != nil {
			fatalf("tzcode tarball lacks %s: %v", need, err)
		}
	}
	cc := os.Getenv("CC")
	if cc == "" {
		cc = "cc"
	}
	out := filepath.Join(temp, "zic")
	command := exec.Command(cc, "-O2", "-o", out, "zic.c")
	command.Dir = temp
	command.Stderr = os.Stderr
	if err := command.Run(); err != nil {
		fatalf("build zic with %s (set CC to choose the compiler): %v", cc, err)
	}
	return out
}

func dataFiles(temp string) []string {
	paths := make([]string, 0, len(zicSourceFiles))
	for _, name := range zicSourceFiles {
		path := filepath.Join(temp, name)
		if _, err := os.Stat(path); err != nil {
			fatalf("tzdata tarball lacks %s: %v", name, err)
		}
		paths = append(paths, path)
	}
	return paths
}

// aliasScript asks the production node which candidates it accepts and which
// zone each one is, then verifies the id and that zone report the same offset at
// every probe instant. ICU's legacy ids are aliases in its zone table; if a
// future ICU instead gives one rules of its own, the offset check fails rather
// than pinning a wrong copy. Candidates whose canonical zone the release does
// not compile cannot be copied and are reported, not silently skipped.
const aliasScript = `
import { readFileSync } from "node:fs";
const payload = JSON.parse(readFileSync(process.argv[2], "utf8"));
const compiled = new Set(payload.compiled);
const build = (zone) => new Intl.DateTimeFormat("en-US", {
  timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit",
  day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
});
const offsetAt = (format, at) => {
  const parts = {};
  for (const { type, value } of format.formatToParts(at)) parts[type] = value;
  const local = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
  return (local - at) / 1000;
};
const formats = new Map();
const format = (zone) => {
  if (!formats.has(zone)) formats.set(zone, build(zone));
  return formats.get(zone);
};
const aliases = {}, selfNamed = [], unavailable = [], mismatches = [];
let accepted = 0;
for (const name of payload.candidates) {
  if (compiled.has(name)) continue;
  let canonical;
  try {
    canonical = build(name).resolvedOptions().timeZone;
  } catch {
    continue;
  }
  accepted += 1;
  if (!canonical) {
    unavailable.push([name, null]);
    continue;
  }
  if (canonical === name) {
    selfNamed.push(name);
    continue;
  }
  if (!compiled.has(canonical)) {
    unavailable.push([name, canonical]);
    continue;
  }
  for (const at of payload.instants) {
    if (offsetAt(format(name), at) !== offsetAt(format(canonical), at)) {
      mismatches.push([name, canonical, at]);
      break;
    }
  }
  aliases[name] = canonical;
}
process.stdout.write(JSON.stringify({ aliases, accepted, selfNamed, unavailable, mismatches }));
`

// installAliases copies each ICU-only id's zone under the id inside the
// compiled tree, after node has resolved and verified it, and returns the
// discovered id -> canonical mapping.
func installAliases(temp, zones, node string, candidates []string) (map[string]string, []string) {
	instants := make([]int64, 0, 2400)
	for year := 1900; year <= 2100; year++ {
		for month := 0; month < 12; month++ {
			instants = append(instants, time.Date(year, time.Month(month+1), 15, 12, 0, 0, 0, time.UTC).UnixMilli())
		}
	}
	payload, err := json.Marshal(struct {
		Candidates []string `json:"candidates"`
		Compiled   []string `json:"compiled"`
		Instants   []int64  `json:"instants"`
	}{Candidates: candidates, Compiled: treeNames(zones), Instants: instants})
	if err != nil {
		fatal(err)
	}
	scriptPath := filepath.Join(temp, "aliases.mjs")
	payloadPath := filepath.Join(temp, "aliases.json")
	if err := os.WriteFile(scriptPath, []byte(aliasScript), 0o644); err != nil {
		fatal(err)
	}
	if err := os.WriteFile(payloadPath, payload, 0o644); err != nil {
		fatal(err)
	}
	out := run(node, scriptPath, payloadPath)
	var result struct {
		Aliases     map[string]string `json:"aliases"`
		Accepted    int               `json:"accepted"`
		SelfNamed   []string          `json:"selfNamed"`
		Unavailable [][2]any          `json:"unavailable"`
		Mismatches  [][3]any          `json:"mismatches"`
	}
	if err := json.Unmarshal(out, &result); err != nil {
		fatalf("parse alias resolution from %s: %v", node, err)
	}
	if len(result.Unavailable) > 0 {
		shown := result.Unavailable
		if len(shown) > 6 {
			shown = shown[:6]
		}
		fatalf("%s accepts %d candidate(s) whose canonical zone the release does not compile, so no copy can be installed: %v",
			node, len(result.Unavailable), shown)
	}
	sort.Strings(result.SelfNamed)
	if len(result.Mismatches) > 0 {
		shown := result.Mismatches
		if len(shown) > 3 {
			shown = shown[:3]
		}
		fatalf("%s gives the ICU alias ids their own rules, not a copy of the canonical zone: %v", node, shown)
	}
	installed := make(map[string]string, len(result.Aliases))
	for name, canonical := range result.Aliases {
		source := filepath.Join(zones, filepath.FromSlash(canonical))
		body, err := os.ReadFile(source)
		if err != nil {
			fatalf("alias %s resolves to %q, which the release does not compile: %v", name, canonical, err)
		}
		target := filepath.Join(zones, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			fatal(err)
		}
		if err := os.WriteFile(target, body, 0o644); err != nil {
			fatal(err)
		}
		installed[name] = canonical
	}
	fmt.Printf("alias discovery: %d candidates, %d accepted, %d installed, %d self-named without an IANA file\n",
		len(candidates), result.Accepted, len(installed), len(result.SelfNamed))
	return installed, result.SelfNamed
}

// candidateNames is every name ICU could resolve: the release's own Zone and
// Link names, every name a historical release defined (including links tzdata
// dropped since), and every two-, three- and four-letter id — ICU's legacy
// System V ids were never tzdata names.
func candidateNames(temp string, history []byte) []string {
	names := map[string]bool{}
	for _, file := range zicSourceFiles {
		body, err := os.ReadFile(filepath.Join(temp, file))
		if err != nil {
			fatal(err)
		}
		for _, name := range sourceNames(body) {
			names[name] = true
		}
	}
	historyDir := filepath.Join(temp, "history")
	if err := unpackTarGz(history, historyDir); err != nil {
		fatalf("unpack historical name source: %v", err)
	}
	entries, err := os.ReadDir(historyDir)
	if err != nil {
		fatal(err)
	}
	for _, entry := range entries {
		if entry.IsDir() || strings.HasSuffix(entry.Name(), ".tab") {
			continue
		}
		body, err := os.ReadFile(filepath.Join(historyDir, entry.Name()))
		if err != nil {
			fatal(err)
		}
		for _, name := range sourceNames(body) {
			names[name] = true
		}
	}
	for _, name := range shortNames() {
		names[name] = true
	}
	sorted := make([]string, 0, len(names))
	for name := range names {
		sorted = append(sorted, name)
	}
	sort.Strings(sorted)
	return sorted
}

// sourceNames returns the Zone and Link names a tzdata source file defines or
// mentions. Commented definitions count: releases retire a link by commenting
// its line (2026e has "#Link America/Regina Canada/East-Saskatchewan"), and
// ICU may still accept the id, so it must stay a discovery candidate.
func sourceNames(body []byte) []string {
	var names []string
	for _, line := range strings.Split(string(body), "\n") {
		line = strings.TrimLeft(line, "# \t")
		if index := strings.IndexByte(line, '#'); index >= 0 {
			line = line[:index]
		}
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		switch fields[0] {
		case "Zone":
			names = append(names, fields[1])
		case "Link":
			names = append(names, fields[2])
		}
	}
	return names
}

// shortNames is every two-, three- and four-letter uppercase id.
func shortNames() []string {
	names := make([]string, 0, 26*26+26*26*26+26*26*26*26)
	for length := 2; length <= 4; length++ {
		total := 1
		for index := 0; index < length; index++ {
			total *= 26
		}
		digits := make([]int, length)
		name := make([]byte, length)
		for count := 0; count < total; count++ {
			for index := 0; index < length; index++ {
				name[index] = byte('A' + digits[index])
			}
			names = append(names, string(name))
			for index := length - 1; index >= 0; index-- {
				digits[index]++
				if digits[index] < 26 {
					break
				}
				digits[index] = 0
			}
		}
	}
	return names
}

// treeNames lists the zone file names zic compiled under directory.
func treeNames(directory string) []string {
	var names []string
	err := filepath.WalkDir(directory, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		name, err := filepath.Rel(directory, path)
		if err != nil {
			return err
		}
		names = append(names, filepath.ToSlash(name))
		return nil
	})
	if err != nil {
		fatal(err)
	}
	sort.Strings(names)
	return names
}

// unpackTarGz writes the regular files of a gzipped tar archive under directory.
func unpackTarGz(body []byte, directory string) error {
	unpacked, err := gzip.NewReader(bytes.NewReader(body))
	if err != nil {
		return err
	}
	reader := tar.NewReader(unpacked)
	for {
		header, err := reader.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		if header.Typeflag != tar.TypeReg || strings.Contains(header.Name, "/") {
			continue
		}
		payload, err := io.ReadAll(reader)
		if err != nil {
			return err
		}
		if err := os.MkdirAll(directory, 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(directory, header.Name), payload, 0o644); err != nil {
			return err
		}
	}
}

// writeZip packs every compiled zone under its IANA name. Entries are sorted
// and carry no timestamp so the archive is reproducible; the returned digest
// is the one tzdata_gen.go pins.
func writeZip(root, target string) ([]string, string) {
	var files []string
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		files = append(files, path)
		return nil
	})
	if err != nil {
		fatal(err)
	}
	sort.Strings(files)
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	writer.RegisterCompressor(zip.Deflate, func(w io.Writer) (io.WriteCloser, error) {
		return flate.NewWriter(w, flate.BestCompression)
	})
	names := make([]string, 0, len(files))
	for _, path := range files {
		name, err := filepath.Rel(root, path)
		if err != nil {
			fatal(err)
		}
		name = filepath.ToSlash(name)
		body, err := os.ReadFile(path)
		if err != nil {
			fatal(err)
		}
		header := &zip.FileHeader{Name: name, Method: zip.Deflate}
		header.SetMode(0o644)
		entry, err := writer.CreateHeader(header)
		if err != nil {
			fatal(err)
		}
		if _, err := entry.Write(body); err != nil {
			fatal(err)
		}
		names = append(names, name)
	}
	if err := writer.Close(); err != nil {
		fatal(err)
	}
	if err := os.WriteFile(target, buffer.Bytes(), 0o644); err != nil {
		fatal(err)
	}
	digest := sha256.Sum256(buffer.Bytes())
	return names, hex.EncodeToString(digest[:])
}

// writePackage emits the generated consts and the zone list the corpus
// generator reads.
func writePackage(outDir string, names []string, digest string, versions nodeVersionSet, aliases map[string]string, selfNamed []string) {
	source := fmt.Sprintf(`// Code generated by go run ./genzones; DO NOT EDIT.
//
// Zone data: IANA tzdata %[1]s (tzdata%[1]s.tar.gz sha256 %[2]s,
// tzcode%[1]s.tar.gz sha256 %[3]s), compiled by that release's own zic with
// -b fat, zipped reproducibly.
// Host runtime: Node %[4]s, ICU %[5]s, tz %[1]s.

package tz

const (
	// Version is the IANA tzdata release embedded in zoneinfo.zip.
	Version = %[1]q
	// ZoneinfoSHA256 is the digest of the embedded zip: TestNodeVersionProvenance
	// fails if the two ever disagree.
	ZoneinfoSHA256 = %[6]q
	// ZoneCount is the number of names in zoneinfo.zip, aliases included.
	ZoneCount = %[7]d
	// TarballSHA256 and TzcodeSHA256 pin the official releases.
	TarballSHA256 = %[2]q
	TzcodeSHA256  = %[3]q
	// NodeVersion and ICUVersion pin the runtime whose zone data this is.
	NodeVersion = %[4]q
	ICUVersion  = %[5]q
)

// ICUOnlyAliasZones maps each zone id production Node's ICU accepts that IANA
// tzdata %[1]s does not carry to the zone it resolves to. zoneinfo.zip carries a
// byte-identical copy of that zone under the id. genzones discovers the ids by
// probing the release's names, the names of tzdata %[8]s, and every two- to
// four-letter id through the runtime, so this table is data, not a hand pin.
var ICUOnlyAliasZones = map[string]string{
%[9]s}

// ICUZonesWithoutIANAFile are ids production Node's ICU accepts as zones of its
// own (resolvedOptions returns the id itself): ICU implements their POSIX-style
// rules directly, and tzdata has no file to embed. tz.Load reads them as UTC;
// they are not IANA names. Recorded so a regeneration makes any change visible.
var ICUZonesWithoutIANAFile = []string{
%[10]s}
`, tzdataVersion, tzdataSHA256, tzcodeSHA256, versions.Node, versions.ICU, digest, len(names), historyVersion, aliasLiteral(aliases), stringLiteral(selfNamed))
	formatted, err := format.Source([]byte(source))
	if err != nil {
		fatalf("format tzdata_gen.go: %v", err)
	}
	if err := os.WriteFile(filepath.Join(outDir, "tzdata_gen.go"), formatted, 0o644); err != nil {
		fatal(err)
	}
	list := map[string]any{"version": tzdataVersion, "names": names}
	encoded, err := json.Marshal(list)
	if err != nil {
		fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(outDir, "testdata"), 0o755); err != nil {
		fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outDir, "testdata", "zone-names.json"), append(encoded, '\n'), 0o644); err != nil {
		fatal(err)
	}
}

// stringLiteral renders sorted string literals for tzdata_gen.go.
func stringLiteral(values []string) string {
	var builder strings.Builder
	for _, value := range values {
		builder.WriteString(fmt.Sprintf("\t%q,\n", value))
	}
	return builder.String()
}

// aliasLiteral renders the sorted map entries for tzdata_gen.go.
func aliasLiteral(aliases map[string]string) string {
	names := make([]string, 0, len(aliases))
	for name := range aliases {
		names = append(names, name)
	}
	sort.Strings(names)
	var builder strings.Builder
	for _, name := range names {
		builder.WriteString(fmt.Sprintf("\t%q: %q,\n", name, aliases[name]))
	}
	return builder.String()
}

func run(name string, args ...string) []byte {
	command := exec.Command(name, args...)
	var stderr bytes.Buffer
	command.Stderr = &stderr
	out, err := command.Output()
	if err != nil {
		fatalf("%s %s: %v: %s", name, strings.Join(args, " "), err, stderr.String())
	}
	return out
}

func fatal(err error) { fatalf("%v", err) }

func fatalf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "genzones: "+format+"\n", args...)
	os.Exit(1)
}
