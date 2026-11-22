package threads

import (
	"slices"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/local"
)

// withLive is messagesWithLiveEvents: the persisted page, then the live progress of the active
// runs that is not already in it.
func (s snapshotReader) withLive(threadID string, persisted []map[string]any, liveRuns, activeRuns []runRow) ([]any, error) {
	messages := make([]any, 0, len(persisted))
	for _, message := range persisted {
		messages = append(messages, message)
	}
	if len(liveRuns) == 0 {
		return messages, nil
	}
	runIDs := make([]string, len(liveRuns))
	for index, run := range liveRuns {
		runIDs[index] = run.ID
	}
	rows, err := s.tx.Query(s.ctx, `SELECT id, "spaceId", "threadId", "botId", seq, type, payload, "runId", "createdAt"
		FROM events WHERE "threadId" = $1 AND "runId" = ANY($2) AND type = ANY($3) ORDER BY seq`,
		threadID, runIDs, liveEventTypes)
	if err != nil {
		return nil, err
	}
	var events []liveEvent
	var open []map[string]any
	for rows.Next() {
		var event liveEvent
		var spaceID string
		var payload []byte
		if err := rows.Scan(&event.ID, &spaceID, &event.ThreadID, &event.BotID, &event.Seq, &event.Type, &payload, &event.RunID, &event.CreatedAt); err != nil {
			rows.Close()
			return nil, err
		}
		decoded, err := decodeJSON(payload)
		if err != nil {
			rows.Close()
			return nil, err
		}
		events = append(events, event)
		open = append(open, map[string]any{"id": event.ID, "spaceId": spaceID, "threadId": event.ThreadID, "payload": decoded})
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := s.open("Event", open); err != nil {
		return nil, err
	}
	for index := range events {
		// asRecord: anything but an object reads as an empty one.
		events[index].Payload, _ = open[index]["payload"].(map[string]any)
		if events[index].Payload == nil {
			events[index].Payload = map[string]any{}
		}
	}
	statuses := make(map[string]string, len(activeRuns))
	for _, run := range activeRuns {
		statuses[run.ID] = run.Status
	}
	for _, message := range projectLive(events, statuses) {
		if !keepLive(message, persisted) {
			continue
		}
		view, err := liveView(message)
		if err != nil {
			return nil, err
		}
		messages = append(messages, view)
	}
	return messages, nil
}

// keepLive is the filter of messagesWithLiveEvents: progress, thinking and steps always show; a
// subagent card shows until a persisted block carries it.
func keepLive(message liveMessage, persisted []map[string]any) bool {
	for _, block := range message.Blocks {
		if block["kind"] == "progress" || block["kind"] == "thinking" || block["kind"] == "steps" {
			return true
		}
	}
	if len(message.ID) < len("subagent:") || message.ID[:len("subagent:")] != "subagent:" {
		return false
	}
	return !slices.ContainsFunc(persisted, func(row map[string]any) bool {
		for _, block := range row["blocks"].([]any) {
			entry := block.(map[string]any)
			if entry["kind"] == "subagent" && message.ID == "subagent:"+entry["agentId"].(string) {
				return true
			}
		}
		return false
	})
}

// liveView is a projected message as ThreadMessageSchema returns it.
func liveView(message liveMessage) (map[string]any, error) {
	entries := make([]any, len(message.Blocks))
	for index, block := range message.Blocks {
		entries[index] = numberize(block)
	}
	blocks, valid, decidable := parseBlocks(entries)
	if !decidable {
		return nil, local.ErrDecline
	}
	if !valid || message.BotID == "" {
		return nil, outputInvalid()
	}
	view := map[string]any{
		"id": message.ID, "threadId": message.ThreadID, "seq": message.Seq, "role": "bot", "blocks": blocks,
		"botId": message.BotID, "createdAt": message.CreatedAt,
	}
	if message.RunID != "" {
		view["runId"] = message.RunID
	}
	return view, nil
}
