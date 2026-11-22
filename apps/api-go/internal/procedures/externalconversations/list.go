package externalconversations

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/contentcrypto"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

// AutomatedSender is AutomatedSenderSchema: a bot sender the conversation has seen.
type AutomatedSender struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Conversation is ExternalConversationSchema (packages/contracts/src/threads/
// external-conversations.ts:57).
type Conversation struct {
	ID                      string            `json:"id"`
	SpaceID                 string            `json:"spaceId"`
	BotID                   string            `json:"botId"`
	Provider                string            `json:"provider"`
	DisplayName             *string           `json:"displayName"`
	ParticipantNames        []string          `json:"participantNames"`
	TeamChatAmbientEnabled  *bool             `json:"teamChatAmbientEnabled"`
	TeamChatRules           *string           `json:"teamChatRules"`
	AutomatedSenderPolicies json.RawMessage   `json:"automatedSenderPolicies"`
	AutomatedSenders        []AutomatedSender `json:"automatedSenders"`
	ThreadID                string            `json:"threadId"`
	Preview                 string            `json:"preview"`
	Unread                  bool              `json:"unread"`
	UpdatedAt               string            `json:"updatedAt"`
}

type conversationRow struct {
	ID                     string
	SpaceID                string
	BotID                  string
	Provider               string
	DisplayName            *string
	ParticipantNames       any
	TeamChatAmbientEnabled *bool
	TeamChatRules          *string
	Policies               string
	ThreadID               *string
	Unread                 *bool
	UpdatedAt              time.Time
}

// ListForSpaces is createExternalConversationRepos().listForSpaces (packages/db/src/
// spaces/external-conversations.ts:14): the linked external chats of each Space whose bot
// is still open, with the caller's read state, the newest message's preview and the bot
// senders seen in the last 100 messages. spaces.list reads it as system.
func ListForSpaces(
	ctx context.Context,
	tx pgx.Tx,
	ring *contentcrypto.KeyRing,
	spaceIDs []string,
	userID string,
) ([]Conversation, error) {
	conversations := []Conversation{}
	if len(spaceIDs) == 0 {
		return conversations, nil
	}
	rows, err := tx.Query(ctx, `SELECT e.id, e."spaceId", e."botId", e.provider, e."displayName",
			e."participantNames", e."teamChatAmbientEnabled", e."teamChatRules",
			e."automatedSenderPolicies"::text, t.id, r.unread, e."updatedAt"
		FROM external_conversations e
		JOIN bots b ON b.id = e."botId" AND b."archivedAt" IS NULL
		JOIN threads t ON t."externalConversationId" = e.id
		LEFT JOIN thread_reads r ON r."threadId" = t.id AND r."userId" = $2
		WHERE e."spaceId" = ANY($1)
		ORDER BY e."updatedAt" DESC, e.id ASC`, spaceIDs, userID)
	if err != nil {
		return nil, err
	}
	loaded := []conversationRow{}
	for rows.Next() {
		var row conversationRow
		if err := rows.Scan(&row.ID, &row.SpaceID, &row.BotID, &row.Provider, &row.DisplayName,
			&row.ParticipantNames, &row.TeamChatAmbientEnabled, &row.TeamChatRules,
			&row.Policies, &row.ThreadID, &row.Unread, &row.UpdatedAt); err != nil {
			rows.Close()
			return nil, err
		}
		loaded = append(loaded, row)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(loaded) == 0 {
		return conversations, nil
	}

	// withNewestThreadMessages(prisma, rows, 1): the newest message per thread, opened with
	// the Space key.
	threadIDs := make([]string, 0, len(loaded))
	for _, row := range loaded {
		if row.ThreadID != nil {
			threadIDs = append(threadIDs, *row.ThreadID)
		}
	}
	previews := map[string]any{}
	if len(threadIDs) > 0 {
		messageRows, err := tx.Query(ctx, `SELECT m."threadId", m.id, m.blocks
			FROM unnest($1::text[]) AS t(id)
			CROSS JOIN LATERAL (
				SELECT "threadId", id, blocks, seq FROM messages
				WHERE "threadId" = t.id ORDER BY seq DESC LIMIT 1
			) m
			ORDER BY m."threadId", m.seq DESC`, threadIDs)
		if err != nil {
			return nil, err
		}
		type previewRow struct {
			ThreadID string
			ID       string
			Blocks   any
		}
		messages := []previewRow{}
		for messageRows.Next() {
			var message previewRow
			if err := messageRows.Scan(&message.ThreadID, &message.ID, &message.Blocks); err != nil {
				messageRows.Close()
				return nil, err
			}
			messages = append(messages, message)
		}
		messageRows.Close()
		if err := messageRows.Err(); err != nil {
			return nil, err
		}
		if ring != nil {
			open := make([]map[string]any, len(messages))
			for index, message := range messages {
				open[index] = map[string]any{
					"id": message.ID, "threadId": message.ThreadID, "blocks": message.Blocks,
				}
			}
			if err := ring.OpenRows(ctx, "Message", open); err != nil {
				return nil, err
			}
			for index := range messages {
				messages[index].Blocks = open[index]["blocks"]
			}
		}
		for _, message := range messages {
			previews[message.ThreadID] = message.Blocks
		}
	}

	// The last 100 bot senders per conversation, newest first.
	conversationIDs := make([]string, 0, len(loaded))
	for _, row := range loaded {
		conversationIDs = append(conversationIDs, row.ID)
	}
	senders := map[string][]AutomatedSender{}
	senderRows, err := tx.Query(ctx, `SELECT e."externalConversationId", e."senderId", e."senderName"
		FROM unnest($1::text[]) AS c(id)
		CROSS JOIN LATERAL (
			SELECT "externalConversationId", "senderId", "senderName", "createdAt"
			FROM external_messages
			WHERE "externalConversationId" = c.id AND "senderIsBot"
			ORDER BY "createdAt" DESC
			LIMIT 100
		) e
		ORDER BY e."externalConversationId", e."createdAt" DESC`, conversationIDs)
	if err != nil {
		return nil, err
	}
	positions := map[string]map[string]int{}
	for senderRows.Next() {
		var conversationID, senderID, senderName string
		if err := senderRows.Scan(&conversationID, &senderID, &senderName); err != nil {
			senderRows.Close()
			return nil, err
		}
		index, seen := positions[conversationID]
		if !seen {
			index = map[string]int{}
			positions[conversationID] = index
		}
		if at, exists := index[senderID]; exists {
			// new Map(...).values(): a later row keeps the first position and replaces the
			// value, so the oldest name of a sender wins.
			senders[conversationID][at].Name = senderName
			continue
		}
		index[senderID] = len(senders[conversationID])
		senders[conversationID] = append(senders[conversationID], AutomatedSender{ID: senderID, Name: senderName})
	}
	senderRows.Close()
	if err := senderRows.Err(); err != nil {
		return nil, err
	}

	for _, row := range loaded {
		if row.ThreadID == nil {
			return nil, shared.NotFound
		}
		participants, failure := participantNames(row.ParticipantNames)
		if failure != nil {
			return nil, failure
		}
		policies, failure := storedPoliciesJSON(row.Policies)
		if failure != nil {
			return nil, failure
		}
		conversation := Conversation{
			ID:                      row.ID,
			SpaceID:                 row.SpaceID,
			BotID:                   row.BotID,
			Provider:                row.Provider,
			DisplayName:             row.DisplayName,
			ParticipantNames:        participants,
			TeamChatAmbientEnabled:  row.TeamChatAmbientEnabled,
			TeamChatRules:           row.TeamChatRules,
			AutomatedSenderPolicies: policies,
			AutomatedSenders:        senders[row.ID],
			ThreadID:                *row.ThreadID,
			Preview:                 shared.PreviewFromBlocks(previews[*row.ThreadID]),
			Unread:                  row.Unread != nil && *row.Unread,
			UpdatedAt:               shared.ISO(row.UpdatedAt),
		}
		if conversation.AutomatedSenders == nil {
			conversation.AutomatedSenders = []AutomatedSender{}
		}
		if failure := validateConversation(conversation); failure != nil {
			return nil, failure
		}
		conversations = append(conversations, conversation)
	}
	return conversations, nil
}

// participantNames is z.array(z.string()) over the stored jsonb.
func participantNames(stored any) ([]string, *orpc.Error) {
	items, ok := stored.([]any)
	if !ok {
		return nil, shared.OutputInvalid()
	}
	names := make([]string, 0, len(items))
	for _, item := range items {
		name, ok := item.(string)
		if !ok {
			return nil, shared.OutputInvalid()
		}
		names = append(names, name)
	}
	return names, nil
}

// storedPoliciesJSON is AutomatedSenderPoliciesSchema.parse of the stored jsonb, written
// back in its parsed shape (keys and names trimmed, at most 50 entries).
func storedPoliciesJSON(stored string) (json.RawMessage, *orpc.Error) {
	object, issues := validate.Decode([]byte(stored), nil)
	if issues != nil {
		return nil, shared.OutputInvalid()
	}
	entries, issues := parsePolicies(object)
	if issues != nil {
		return nil, shared.OutputInvalid()
	}
	return json.RawMessage(policiesJSON(entries, false)), nil
}

// validateConversation is the router's parse of ExternalConversationSchema.
func validateConversation(conversation Conversation) *orpc.Error {
	if conversation.ID == "" || conversation.SpaceID == "" || conversation.BotID == "" ||
		conversation.ThreadID == "" {
		return shared.OutputInvalid()
	}
	for _, sender := range conversation.AutomatedSenders {
		if sender.ID == "" || len([]rune(sender.ID)) > 200 || sender.Name == "" ||
			len([]rune(sender.Name)) > 120 {
			return shared.OutputInvalid()
		}
	}
	return nil
}
