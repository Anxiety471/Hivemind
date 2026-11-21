// Package taskdetect owns backend task detection and Kanban ticket
// synchronization for bots: loading assigned open-ticket context for a run,
// preparing a completed turn's transcript for task extraction, and parsing,
// deduplicating, persisting, and publishing detected ticket changes without
// triggering bot wakeup loops.
package taskdetect

// MaxActionsPerTurn bounds how many ticket creates/updates one detected turn may apply.
const MaxActionsPerTurn = 5

// MaxOpenTicketsInContext bounds how many open assigned tickets are loaded into prompt context.
const MaxOpenTicketsInContext = 25

// DefaultContextMaxBytes bounds rendered ticket context size in bytes.
const DefaultContextMaxBytes = 4 * 1024

// MaxTranscriptChars bounds the turn transcript handed to the task extractor.
const MaxTranscriptChars = 16_000

// MaxMessageChars bounds a single message excerpt inside the transcript.
const MaxMessageChars = 4_000

// OpenTicket is a compact view of a bot's existing Kanban ticket.
type OpenTicket struct {
	ID          string  `json:"id"`
	Ref         string  `json:"ref"`
	Title       string  `json:"title"`
	Status      string  `json:"status"`
	Priority    string  `json:"priority"`
	Description *string `json:"description,omitempty"`
}

// ContextRequest asks for a bot's assigned open tickets and any referenced tickets.
type ContextRequest struct {
	SpaceID    string `json:"spaceId"`
	UserID     string `json:"userId"`
	BotID      string `json:"botId"`
	PromptText string `json:"promptText"`
	MaxBytes   int    `json:"maxBytes,omitempty"`
}

// ContextResponse carries prompt-ready ticket blocks and open ticket summaries.
type ContextResponse struct {
	Enabled           bool         `json:"enabled"`
	AssignedContext   string       `json:"assignedContext,omitempty"`
	ReferencedContext string       `json:"referencedContext,omitempty"`
	OpenTickets       []OpenTicket `json:"openTickets"`
}

// PrepareRequest asks whether a completed run should be inspected for missed
// tasks and, when eligible, returns the extraction prompts and open tickets.
type PrepareRequest struct {
	RunID              string   `json:"runId"`
	SpaceID            string   `json:"spaceId"`
	UserID             string   `json:"userId"`
	BotID              string   `json:"botId"`
	AnsweredMessageIDs []string `json:"answeredMessageIds,omitempty"`
}

// PrepareResponse describes whether a run should be sent to the extractor model.
type PrepareResponse struct {
	Inspect      bool         `json:"inspect"`
	Reason       string       `json:"reason,omitempty"`
	SystemPrompt string       `json:"systemPrompt,omitempty"`
	UserPrompt   string       `json:"userPrompt,omitempty"`
	OpenTickets  []OpenTicket `json:"openTickets,omitempty"`
}

// Action is one task mutation extracted from a completed turn.
type Action struct {
	Op          string  `json:"op"`
	TicketID    string  `json:"ticketId,omitempty"`
	Ref         string  `json:"ref,omitempty"`
	Title       string  `json:"title,omitempty"`
	Description *string `json:"description,omitempty"`
	Status      string  `json:"status,omitempty"`
	Priority    string  `json:"priority,omitempty"`
}

// ApplyRequest applies either raw model output or structured actions to the Space's board.
type ApplyRequest struct {
	RunID     string   `json:"runId"`
	SpaceID   string   `json:"spaceId"`
	UserID    string   `json:"userId"`
	BotID     string   `json:"botId"`
	RawOutput string   `json:"rawOutput,omitempty"`
	Actions   []Action `json:"actions,omitempty"`
}

// AppliedTicket records one ticket created or updated on the board.
type AppliedTicket struct {
	ID       string `json:"id"`
	Ref      string `json:"ref"`
	Title    string `json:"title"`
	Status   string `json:"status"`
	Priority string `json:"priority"`
	Op       string `json:"op"`
}

// ApplyResponse reports what the board sync wrote.
type ApplyResponse struct {
	Created []AppliedTicket `json:"created"`
	Updated []AppliedTicket `json:"updated"`
	Skipped int             `json:"skipped"`
}
