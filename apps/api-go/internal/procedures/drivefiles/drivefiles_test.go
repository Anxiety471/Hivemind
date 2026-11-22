package drivefiles

import (
	"context"
	"net/http"
	"testing"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
)

func TestProceduresFailUnavailableWhenDriveIsNil(t *testing.T) {
	procs := Procedures(nil)
	if len(procs) != 20 {
		t.Fatalf("expected 20 procedures, got %d", len(procs))
	}
	for _, p := range procs {
		if p.Serve == nil {
			t.Fatalf("%s has nil Serve", p.Name)
		}
		_, failure := p.Serve(context.Background(), db.Actor{UserID: "u", SpaceID: "s"}, orpc.Input{Raw: []byte(`{"artifactId":"a1","fileId":"f1","folderId":"d1","name":"n","botId":"b1","mimeType":"text/plain","contentBase64":"YQ=="}`)})
		if failure == nil || failure.Status != http.StatusServiceUnavailable {
			t.Fatalf("%s: expected 503 Unavailable with nil drive service, got %+v", p.Name, failure)
		}
	}
}
