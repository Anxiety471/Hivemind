package effects

import (
	"crypto/rand"
	"math/big"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	cuidMu      sync.Mutex
	cuidCounter uint64
	cuidPrint   = fingerprint()
)

const cuidBase = 36

func fingerprint() string {
	host, _ := os.Hostname()
	sum := len(host) + cuidBase
	for _, char := range host {
		sum += int(char)
	}
	return pad(strconv.FormatInt(int64(os.Getpid()), cuidBase), 2) + pad(strconv.FormatInt(int64(sum), cuidBase), 2)
}

func pad(value string, size int) string {
	if len(value) >= size {
		return value[len(value)-size:]
	}
	return strings.Repeat("0", size-len(value)) + value
}

func randomBlock() string {
	limit := big.NewInt(1)
	for i := 0; i < 4; i++ {
		limit.Mul(limit, big.NewInt(cuidBase))
	}
	value, err := rand.Int(rand.Reader, limit)
	if err != nil {
		value = big.NewInt(time.Now().UnixNano() % limit.Int64())
	}
	return pad(strconv.FormatInt(value.Int64(), cuidBase), 4)
}

// NewID is a cuid (v1), the shape of Prisma's `@default(cuid())` ids: 25 characters.
func NewID() string {
	cuidMu.Lock()
	count := cuidCounter
	cuidCounter = (cuidCounter + 1) % (cuidBase * cuidBase * cuidBase * cuidBase)
	cuidMu.Unlock()
	return "c" + pad(strconv.FormatInt(time.Now().UnixMilli(), cuidBase), 8) +
		pad(strconv.FormatUint(count, cuidBase), 4) + cuidPrint + randomBlock() + randomBlock()
}
