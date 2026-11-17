package effects

import (
	"context"
	"fmt"
	"net"
	"net/netip"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"
)

// LocalNetworks trusts loopback and every network this process has an interface on.
const LocalNetworks = "local-networks"

const noProxies = "none"
const hostTTL = 30 * time.Second

var hostnamePattern = regexp.MustCompile(`(?i)^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$`)
var portSuffix = regexp.MustCompile(`^[\d.]+:\d+$`)
var bracketed = regexp.MustCompile(`^\[([^\]]+)\](?::\d+)?$`)
var mappedV4 = regexp.MustCompile(`(?i)^::ffff:(\d+\.\d+\.\d+\.\d+)$`)

// DefaultTrustedProxies is what an unset TRUSTED_PROXIES trusts (client-ip.ts
// defaultTrustedProxies): the stack's own networks in a container, loopback on a host.
func DefaultTrustedProxies() []string {
	for _, marker := range []string{"/.dockerenv", "/run/.containerenv"} {
		if _, err := os.Stat(marker); err == nil {
			return []string{LocalNetworks}
		}
	}
	return []string{"127.0.0.1", "::1"}
}

// ParseTrustedProxies splits TRUSTED_PROXIES the way env.ts does.
func ParseTrustedProxies(raw string) []string {
	var entries []string
	for _, entry := range regexp.MustCompile(`[\s,]+`).Split(raw, -1) {
		if entry = strings.TrimSpace(entry); entry != "" {
			entries = append(entries, entry)
		}
	}
	return entries
}

// ClientIPResolver resolves the caller's address (client-ip.ts createClientIpResolver):
// the socket peer, unless it is a trusted proxy, in which case the forwarded header
// is read right to left, skipping trusted hops.
type ClientIPResolver struct {
	prefixes  []netip.Prefix
	hostnames []string
	lookup    func(context.Context, string) ([]string, error)
	now       func() time.Time

	mu         sync.Mutex
	resolved   map[string]map[string]bool
	resolvedAt time.Time
}

// NewClientIPResolver builds a resolver; a bad entry is an error so a bad
// TRUSTED_PROXIES stops startup.
func NewClientIPResolver(trusted []string) (*ClientIPResolver, error) {
	resolver := &ClientIPResolver{
		lookup: func(ctx context.Context, host string) ([]string, error) {
			return net.DefaultResolver.LookupHost(ctx, host)
		},
		now:      time.Now,
		resolved: map[string]map[string]bool{},
	}
	var entries []string
	for _, entry := range trusted {
		switch entry {
		case noProxies:
		case LocalNetworks:
			entries = append(entries, localNetworks()...)
		default:
			entries = append(entries, entry)
		}
	}
	for _, entry := range entries {
		address, prefix, hasPrefix := strings.Cut(entry, "/")
		parsed, err := netip.ParseAddr(address)
		switch {
		case err == nil && !hasPrefix:
			parsed = parsed.Unmap()
			resolver.prefixes = append(resolver.prefixes, netip.PrefixFrom(parsed, parsed.BitLen()))
		case err == nil && hasPrefix && !strings.Contains(prefix, "/"):
			var bits int
			if _, scanErr := fmt.Sscanf(prefix, "%d", &bits); scanErr != nil || fmt.Sprint(bits) != prefix || bits < 0 || bits > parsed.BitLen() {
				return nil, fmt.Errorf("TRUSTED_PROXIES entry is not an IP, CIDR range, or hostname: %s", entry)
			}
			resolver.prefixes = append(resolver.prefixes, netip.PrefixFrom(parsed, bits).Masked())
		case err != nil && !hasPrefix && hostnamePattern.MatchString(entry):
			resolver.hostnames = append(resolver.hostnames, entry)
		default:
			return nil, fmt.Errorf("TRUSTED_PROXIES entry is not an IP, CIDR range, or hostname: %s", entry)
		}
	}
	return resolver, nil
}

func localNetworks() []string {
	var cidrs []string
	interfaces, err := net.InterfaceAddrs()
	if err != nil {
		return nil
	}
	for _, address := range interfaces {
		cidrs = append(cidrs, address.String())
	}
	return cidrs
}

// Resolve returns the caller's address, or "" when the peer is not an address.
func (r *ClientIPResolver) Resolve(peer, forwarded string) string {
	remote, ok := parseIP(peer)
	if !ok {
		return ""
	}
	r.refreshHosts()
	if forwarded == "" || !r.trusted(remote) {
		return remote
	}
	hops := strings.Split(forwarded, ",")
	parsed := make([]string, len(hops))
	for index, hop := range hops {
		address, ok := parseIP(strings.TrimSpace(hop))
		if !ok {
			// A malformed chain is not evidence of anything; fall back to the hop we can see.
			return remote
		}
		parsed[index] = address
	}
	for index := len(parsed) - 1; index >= 0; index-- {
		if !r.trusted(parsed[index]) {
			return parsed[index]
		}
	}
	return parsed[0]
}

func (r *ClientIPResolver) trusted(address string) bool {
	parsed, err := netip.ParseAddr(address)
	if err != nil {
		return false
	}
	parsed = parsed.Unmap()
	for _, prefix := range r.prefixes {
		if prefix.Addr().Is4() != parsed.Is4() {
			continue
		}
		if prefix.Contains(parsed) {
			return true
		}
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, addresses := range r.resolved {
		if addresses[address] {
			return true
		}
	}
	return false
}

func (r *ClientIPResolver) refreshHosts() {
	if len(r.hostnames) == 0 {
		return
	}
	r.mu.Lock()
	fresh := r.now().Sub(r.resolvedAt) < hostTTL
	r.mu.Unlock()
	if fresh {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for _, name := range r.hostnames {
		addresses, err := r.lookup(ctx, name)
		if err != nil {
			continue // a failed lookup keeps the last answer
		}
		set := map[string]bool{}
		for _, address := range addresses {
			if normalized, ok := parseIP(address); ok {
				set[normalized] = true
			}
		}
		r.mu.Lock()
		r.resolved[name] = set
		r.mu.Unlock()
	}
	r.mu.Lock()
	r.resolvedAt = r.now()
	r.mu.Unlock()
}

// parseIP is parseIp in client-ip.ts: brackets, a trailing port and IPv4-mapped
// IPv6 are stripped; anything that is not an address is rejected.
func parseIP(value string) (string, bool) {
	candidate := strings.TrimSpace(value)
	if match := bracketed.FindStringSubmatch(candidate); match != nil {
		candidate = match[1]
	} else if portSuffix.MatchString(candidate) {
		candidate = candidate[:strings.LastIndex(candidate, ":")]
	}
	candidate = strings.ToLower(candidate)
	if match := mappedV4.FindStringSubmatch(candidate); match != nil {
		candidate = match[1]
	}
	if net.ParseIP(candidate) == nil || strings.Contains(candidate, "%") {
		return "", false
	}
	return candidate, true
}

// PeerIP is the host part of a request's RemoteAddr.
func PeerIP(remoteAddr string) string {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		return remoteAddr
	}
	return host
}
