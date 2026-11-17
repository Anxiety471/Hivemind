package gateway

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"time"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/local"
)

// shadow answers from the TypeScript API and compares the Go implementation in
// the background. The caller always gets the TypeScript response, so a
// difference is observable in logs and never in behaviour.
func (g *Gateway) shadow(w http.ResponseWriter, r *http.Request, procedure string) {
	body, err := io.ReadAll(io.LimitReader(r.Body, g.local.MaxBody()+1))
	if err != nil {
		g.proxy.ServeHTTP(w, r)
		return
	}
	tooLarge := int64(len(body)) > g.local.MaxBody()
	if tooLarge {
		g.logger.Debug("shadow skipped: request body larger than the local limit", "procedure", procedure)
		r.Body = io.NopCloser(io.MultiReader(bytes.NewReader(body), r.Body))
		g.proxy.ServeHTTP(w, r)
		return
	}

	typescriptRequest := r.Clone(r.Context())
	typescriptRequest.Body = io.NopCloser(bytes.NewReader(body))
	recorder := httptest.NewRecorder()
	g.proxy.ServeHTTP(recorder, typescriptRequest)
	result := recorder.Result()
	typescriptBody, _ := io.ReadAll(result.Body)
	result.Body.Close()

	for name, values := range result.Header {
		for _, value := range values {
			w.Header().Add(name, value)
		}
	}
	w.WriteHeader(result.StatusCode)
	_, _ = w.Write(typescriptBody)

	typescript := local.Snapshot{Status: result.StatusCode, Header: result.Header, Body: typescriptBody}
	goRequest := r.Clone(context.Background())
	goRequest.Body = io.NopCloser(bytes.NewReader(body))
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		snapshot := g.local.Snapshot(ctx, goRequest, procedure)
		if equal, reason := local.Compare(typescript, snapshot); !equal {
			g.logger.Error("go.wire.diff",
				"procedure", procedure,
				"reason", reason,
				"typescript.status", typescript.Status,
				"go.status", snapshot.Status,
			)
			return
		}
		g.logger.Debug("go.wire.match", "procedure", procedure)
	}()
}
