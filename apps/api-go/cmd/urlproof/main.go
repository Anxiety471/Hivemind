// Command urlproof is the Go half of the differential proof for
// internal/whatwgurl. It reads a JSON-lines corpus produced by
// tools/infra-d-url-proof.mts, runs each case through the package and prints
// what Node's URL API is expected to report. The TypeScript driver compares the
// two.
package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/whatwgurl"
)

type testCase struct {
	ID    string      `json:"id"`
	Op    string      `json:"op"`
	Input string      `json:"input"`
	Base  *string     `json:"base,omitempty"`
	Set   string      `json:"set,omitempty"`
	Name  string      `json:"name,omitempty"`
	Value string      `json:"value,omitempty"`
	Pairs [][2]string `json:"pairs,omitempty"`
}

type fields struct {
	Href     string `json:"href"`
	Origin   string `json:"origin"`
	Protocol string `json:"protocol"`
	Username string `json:"username"`
	Password string `json:"password"`
	Host     string `json:"host"`
	Hostname string `json:"hostname"`
	Port     string `json:"port"`
	Pathname string `json:"pathname"`
	Search   string `json:"search"`
	Hash     string `json:"hash"`
	Params   string `json:"params"`
}

type result struct {
	ID     string  `json:"id"`
	OK     bool    `json:"ok"`
	Fields *fields `json:"fields,omitempty"`
	Get    *string `json:"get,omitempty"`
	ZOK    bool    `json:"zok"`
	ZValue string  `json:"zvalue"`
}

func snapshot(u *whatwgurl.URL) *fields {
	return &fields{
		Href:     u.Href(),
		Origin:   u.Origin(),
		Protocol: u.Protocol(),
		Username: u.Username(),
		Password: u.Password(),
		Host:     u.Host(),
		Hostname: u.Hostname(),
		Port:     u.Port(),
		Pathname: u.Pathname(),
		Search:   u.Search(),
		Hash:     u.Hash(),
		Params:   u.SearchParams().String(),
	}
}

func pairList(pairs [][2]string) []whatwgurl.Pair {
	out := make([]whatwgurl.Pair, len(pairs))
	for i := range pairs {
		out[i] = whatwgurl.Pair{Name: pairs[i][0], Value: pairs[i][1]}
	}
	return out
}

func run(c testCase) result {
	out := result{ID: c.ID}
	var u *whatwgurl.URL
	var err error
	switch {
	case c.Op == "parse" && c.Base != nil:
		u, err = whatwgurl.ParseRef(c.Input, *c.Base)
	case c.Op == "parse":
		u, err = whatwgurl.Parse(c.Input)
	case c.Op == "sethostname", c.Op == "setpathname", c.Op == "sethash", c.Op == "setsearch",
		c.Op == "sethost", c.Op == "setport", c.Op == "setprotocol",
		c.Op == "setusername", c.Op == "setpassword", c.Op == "searchparamset":
		u, err = whatwgurl.Parse(c.Input)
		if err == nil {
			switch c.Op {
			case "sethostname":
				u.SetHostname(c.Set)
			case "setpathname":
				u.SetPathname(c.Set)
			case "sethash":
				u.SetHash(c.Set)
			case "setsearch":
				u.SetSearch(c.Set)
			case "sethost":
				u.SetHost(c.Set)
			case "setport":
				u.SetPort(c.Set)
			case "setprotocol":
				u.SetProtocol(c.Set)
			case "setusername":
				u.SetUsername(c.Set)
			case "setpassword":
				u.SetPassword(c.Set)
			case "searchparamset":
				u.SearchParams().Set(c.Name, c.Value)
			}
		}
	case c.Op == "searchparams-object", c.Op == "searchparams-multipair",
		c.Op == "searchparams-append", c.Op == "searchparams-delete",
		c.Op == "searchparams-get":
		u, err = whatwgurl.Parse(c.Input)
		if err == nil {
			params := u.SearchParams()
			switch c.Op {
			case "searchparams-object", "searchparams-multipair":
				// The object corpus uses unique, non-index keys, so its
				// Object.fromEntries order is the pair order given here.
				u.SetSearch(whatwgurl.NewSearchParams(pairList(c.Pairs)).String())
			case "searchparams-append":
				for _, pair := range c.Pairs {
					params.Append(pair[0], pair[1])
				}
			case "searchparams-delete":
				params.Delete(c.Name)
			case "searchparams-get":
				got := params.Get(c.Name)
				out.Get = &got
			}
		}
	default:
		fmt.Fprintf(os.Stderr, "unknown op %q for %s\n", c.Op, c.ID)
		os.Exit(2)
	}
	if err == nil {
		out.OK = true
		out.Fields = snapshot(u)
	}
	out.ZOK = whatwgurl.ZodURLAccepts(c.Input)
	if out.ZOK {
		out.ZValue, _ = whatwgurl.ZodURLValue(c.Input)
	}
	return out
}

func main() {
	corpus := flag.String("corpus", "", "JSON-lines corpus to read")
	outPath := flag.String("out", "", "JSON-lines results to write")
	flag.Parse()
	if *corpus == "" || *outPath == "" {
		fmt.Fprintln(os.Stderr, "usage: urlproof -corpus in.jsonl -out out.jsonl")
		os.Exit(2)
	}
	in, err := os.Open(*corpus)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer in.Close()
	out, err := os.Create(*outPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer out.Close()
	writer := bufio.NewWriterSize(out, 1<<20)
	defer writer.Flush()
	reader := bufio.NewScanner(in)
	reader.Buffer(make([]byte, 1<<20), 1<<26)
	encoder := json.NewEncoder(writer)
	count := 0
	for reader.Scan() {
		var c testCase
		if err := json.Unmarshal(reader.Bytes(), &c); err != nil {
			fmt.Fprintf(os.Stderr, "decode case %d: %v\n", count+1, err)
			os.Exit(1)
		}
		if err := encoder.Encode(run(c)); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		count++
	}
	if err := reader.Err(); err != nil && err != io.EOF {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if err := writer.Flush(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Fprintf(os.Stderr, "urlproof: %d cases\n", count)
}
