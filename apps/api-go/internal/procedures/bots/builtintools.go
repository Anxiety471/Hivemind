package bots

// builtinToolNames is BUILTIN_TOOL_NAMES (packages/contracts/src/bots/builtin-tools.ts:24):
// the tools a bot may disable, in the catalogue's order.
var builtinToolNames = []string{
	"computer_observe", "computer_act", "browser_navigate", "browser_snapshot",
	"browser_act", "list_files", "read_file", "write_file",
	"attach_file", "drive_list", "drive_read", "drive_save", "shell", "user_computer_list", "user_computer_shell",
	"user_computer_observe", "user_computer_act", "open_path", "launch_app",
	"request_takeover", "ask_user", "connect_app", "message_user",
	"request_secret", "generate_secret", "list_secrets", "secret_request",
	"forget_secret", "render_plot", "save_page", "generate_image",
	"generate_video", "add_mcp_server", "remember", "save_shared_memory",
	"web_search", "web_fetch", "service_search", "service_call",
	"cloud_agent_launch", "cloud_agent_status", "cloud_agent_reply", "cloud_agent_cancel",
	"request_purchase", "purchase_status", "paid_request", "search_history",
	"read_history", "read_email", "delete_email", "claim_email_address",
	"send_email", "save_memory", "recall_memory", "forget_memory",
	"reflect_memory", "task_catalog", "scratchpad_list", "scratchpad_add",
	"scratchpad_update", "scratchpad_complete", "scratchpad_remove", "board_tickets",
	"ticket_get", "ticket_create", "ticket_update", "ticket_comment",
	"task_sync", "schedule_create", "schedule_list", "schedule_update",
	"schedule_cancel", "end_call", "call_user", "skill_read",
	"skill_create", "skill_update", "skill_delete", "run_subagent",
	"create_space", "spawn_bot", "update_bot", "list_fleet",
	"create_group", "update_group", "organize_bot", "set_child_instructions",
	"set_child_bot_model", "create_child_routine", "archive_bot", "message_bot",
	"handoff_to_bot", "post_to_group", "update_preferences", "feedback",
	"connect_agent", "respond_agent_connection", "message_agent",
}

// builtinToolNameSet is the membership test isBuiltinToolName makes.
var builtinToolNameSet = func() map[string]bool {
	set := make(map[string]bool, len(builtinToolNames))
	for _, name := range builtinToolNames {
		set[name] = true
	}
	return set
}()
