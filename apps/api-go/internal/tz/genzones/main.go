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
	outDir := flag.String("out", ".", "package directory to write into")
	flag.Parse()

	data := fetch(*tzdataPath, "tzdata"+tzdataVersion+".tar.gz", tzdataSHA256)
	code := fetch(*tzcodePath, "tzcode"+tzdataVersion+".tar.gz", tzcodeSHA256)
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

	names, digest := writeZip(zones, filepath.Join(*outDir, "zoneinfo.zip"))
	versions := nodeVersions(node)
	writePackage(*outDir, names, digest, versions)
	fmt.Printf("tz %s: %d zones, zoneinfo.zip %s, node %s icu %s\n",
		tzdataVersion, len(names), digest, versions.Node, versions.ICU)
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
func writePackage(outDir string, names []string, digest string, versions nodeVersionSet) {
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
`, tzdataVersion, tzdataSHA256, tzcodeSHA256, versions.Node, versions.ICU, digest, len(names))
	if err := os.WriteFile(filepath.Join(outDir, "tzdata_gen.go"), []byte(source), 0o644); err != nil {
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
