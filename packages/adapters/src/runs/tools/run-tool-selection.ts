import type { ConnectorTool } from "@rakazo/adapter-kit";
import {
  disabledBuiltinToolSet,
  FLEET_TOOL_NAMES,
  FLEET_WRITE_TOOL_NAMES,
} from "@rakazo/contracts";
import { BACKGROUND_HELPER_TRIGGER, isBackgroundRunTrigger, isOwnerStartedRun } from "@rakazo/core";
import { selectCloudAgentTools } from "../../cloud-agents/cloud-agent-tools-select.js";
import { selectMemoryTools } from "../../memory/memory-tools.js";
import {
  filterImageReturningComputerTools,
  IMAGE_RETURNING_COMPUTER_TOOLS,
} from "../../models/model-vision.js";
import { builtinAgentTools } from "../../tools/builtin.tool-definition.js";
import { CODE_MODE } from "../../tools/code-mode.tool-definition.js";
import {
  filterBuiltinToolsForRun,
  filterBuiltinToolsForThread,
  SCHEDULE_TOOL_NAMES,
} from "../../tools/schedule-tools.js";
import { SKILL_TOOL_NAMES } from "../../tools/skill-tools.js";
import { USER_COMPUTER_SCREEN_TOOLS } from "./run-tools-user-computer.js";

export const READ_ONLY_AGENT_TOOLS = new Set([
  // The script itself changes nothing, and it must run again each time it is called: every call
  // it makes is gated and recorded on its own, so a stored result would only be stale.
  CODE_MODE,
  "computer_observe",
  "list_files",
  "list_fleet",
  "read_file",
  "drive_list",
  "drive_read",
  "read_history",
  "read_email",
  "search_history",
  "list_history",
  "request_takeover",
  "run_subagent",
  "task_catalog",
  "recall_memory",
  "reflect_memory",
  "search_memory_docs",
  "read_memory_doc",
  "schedule_list",
  "scratchpad_list",
  "board_tickets",
  "ticket_get",
  "skill_read",
  "web_search",
  "web_fetch",
  "service_search",
  "browser_snapshot",
  "list_secrets",
  "cloud_agent_status",
  "purchase_status",
]);

/** The bot's own inbox, offered only in its owner's runs outside groups and channels. */
const EMAIL_INBOX_TOOL_NAMES = new Set(["read_email", "delete_email"]);
const PAID_SERVICE_TOOL_NAMES = new Set(["service_search", "service_call"]);

/** Offered only to a user who connected a wallet. */
const PURCHASE_TOOL_NAMES = new Set(["request_purchase", "purchase_status", "paid_request"]);

export const BUILTIN_AGENT_TOOL_NAMES = new Set(builtinAgentTools.map((tool) => tool.name));

const FLEET_TOOL_NAMES_SET: ReadonlySet<string> = new Set(FLEET_TOOL_NAMES);

export const FLEET_WRITE_TOOL_NAMES_SET: ReadonlySet<string> = new Set(FLEET_WRITE_TOOL_NAMES);

/**
 * The creation intro asks what the bot is for and records the answer on its own profile.
 * It must not act (shell, computer, scheduling, spawning another bot, ...) before the user
 * has said what it is for. Answering its question resumes it as the user's turn, with
 * every tool (see commitAnswerRunInput).
 */
const CREATED_RUN_TOOL_NAMES = new Set(["ask_user", "update_bot"]);

/** Delegation reaches two levels deep (see MAX_HELPER_DEPTH); account settings and direct replies remain the parent's. */
export const SUBAGENT_HIDDEN_TOOLS: ReadonlySet<string> = new Set([
  "spawn_bot",
  "message_user",
  "call_user",
  "end_call",
  "request_takeover",
  "update_bot",
  "update_preferences",
  "feedback",
]);

/** Cross-owner agent connections only exist for chat-linked bots, in turns that can talk. */
export function offersAgentConnectionTools(options: {
  hasMessagingIdentity: boolean;
  crossSpaceCommunication: boolean;
  trigger: string;
}): boolean {
  return (
    options.hasMessagingIdentity &&
    options.crossSpaceCommunication &&
    !isBackgroundRunTrigger(options.trigger) &&
    options.trigger !== "created" &&
    options.trigger !== BACKGROUND_HELPER_TRIGGER
  );
}

export function selectBuiltinToolsForRun(options: {
  ticketBoardEnabled?: boolean;
  phoneCallsEnabled?: boolean;
  historyRetrievalEnabled?: boolean;
  graphicalToolsAllowed: boolean;
  /** Page browser tools need a graphical computer (Chrome), not model vision. */
  pageBrowserAllowed?: boolean;
  groupId: string | null;
  trigger: string;
  semanticMemoryEnabled: boolean;
  /** The configured provider can forget individual facts. */
  semanticMemoryForgets?: boolean;
  /** The configured provider can answer a question from many memories. */
  semanticMemoryReflects?: boolean;
  cloudAgentEnabled?: boolean;
  cloudAgentCleanupEnabled?: boolean;
  /** The run's user connected a payment wallet. */
  paymentWalletEnabled?: boolean;
  mediaImagesEnabled?: boolean;
  mediaVideoEnabled?: boolean;
  /** The deployment configured paid data services. */
  paidServicesEnabled?: boolean;
  /** The owner turned on the code lab: one script may call several tools. */
  codeModeEnabled?: boolean;
  messagingChannelRun: boolean;
  /** Hanging up is only offered to a turn the caller spoke on a live call. */
  voiceCall?: boolean;
  /** Built-in names this bot turned off. Unknown names are ignored. */
  disabledBuiltinTools?: readonly string[];
  fleetManagement?: boolean;
  /** The bot belongs to a group other than the one this run is in. */
  hasGroups?: boolean;
  /** A follow-up run whose source message the user wrote. */
  followUpFromUser?: boolean;
  /** The person who started this run has their desktop connected (see userComputerOwner). */
  userComputer?: boolean;
  /** Their connected desktop can look at and drive its apps. */
  userComputerScreen?: boolean;
  /** The bot has an email address and this run is its owner's own, outside any group or channel. */
  emailInbox?: boolean;
  /** This server receives email and the bot has no address yet. */
  emailClaimable?: boolean;
  /** The inbox may be read and this server can send email. */
  emailSend?: boolean;
}) {
  const disabled = disabledBuiltinToolSet(options.disabledBuiltinTools);
  const ownerStartedRun = isOwnerStartedRun(options.trigger, Boolean(options.followUpFromUser));
  // Claiming is offered only in the owner's own chat, so once the bot claims an address there it
  // can read the mail that follows, such as a sign-up code, in the same run.
  const emailClaimOffered =
    Boolean(options.emailClaimable) &&
    ownerStartedRun &&
    !options.groupId &&
    !options.messagingChannelRun;
  const emailMailbox = Boolean(options.emailInbox) || emailClaimOffered;
  return selectCloudAgentTools(
    selectMemoryTools(
      filterBuiltinToolsForRun(
        filterBuiltinToolsForThread(
          filterPageBrowserTools(
            filterImageReturningComputerTools(builtinAgentTools, options.graphicalToolsAllowed),
            options.pageBrowserAllowed ?? options.graphicalToolsAllowed,
          ),
          options.groupId,
        ),
        options.trigger,
      ),
      options.semanticMemoryEnabled,
      Boolean(options.semanticMemoryForgets),
      Boolean(options.semanticMemoryReflects),
    ),
    Boolean(options.cloudAgentEnabled),
    Boolean(options.cloudAgentCleanupEnabled),
  ).filter(
    (tool) =>
      !disabled.has(tool.name) &&
      (options.trigger !== "created" || CREATED_RUN_TOOL_NAMES.has(tool.name)) &&
      (options.trigger !== BACKGROUND_HELPER_TRIGGER || !SUBAGENT_HIDDEN_TOOLS.has(tool.name)) &&
      (!FLEET_TOOL_NAMES_SET.has(tool.name) ||
        (Boolean(options.fleetManagement) && ownerStartedRun)) &&
      (ownerStartedRun || (tool.name !== "update_preferences" && tool.name !== "feedback")) &&
      (options.paymentWalletEnabled || !PURCHASE_TOOL_NAMES.has(tool.name)) &&
      (options.mediaImagesEnabled || tool.name !== "generate_image") &&
      (options.mediaVideoEnabled || tool.name !== "generate_video") &&
      (options.paidServicesEnabled || !PAID_SERVICE_TOOL_NAMES.has(tool.name)) &&
      (options.codeModeEnabled || tool.name !== CODE_MODE) &&
      (options.hasGroups === true || tool.name !== "post_to_group") &&
      (options.ticketBoardEnabled ||
        (tool.name !== "board_tickets" &&
          tool.name !== "task_sync" &&
          !tool.name.startsWith("ticket_"))) &&
      (!options.ticketBoardEnabled || !tool.name.startsWith("scratchpad_")) &&
      (!isBackgroundRunTrigger(options.trigger) ||
        ![
          "message_user",
          "message_bot",
          "handoff_to_bot",
          "message_agent",
          "generate_image",
          "generate_video",
        ].includes(tool.name)) &&
      (options.voiceCall || tool.name !== "end_call") &&
      (emailMailbox || !EMAIL_INBOX_TOOL_NAMES.has(tool.name)) &&
      ((emailMailbox && options.emailSend) || tool.name !== "send_email") &&
      (emailClaimOffered || tool.name !== "claim_email_address") &&
      (options.userComputer || tool.name !== "user_computer_shell") &&
      (options.userComputer || options.userComputerScreen || tool.name !== "user_computer_list") &&
      (options.userComputerScreen || !USER_COMPUTER_SCREEN_TOOLS.has(tool.name)) &&
      // Already on a call, or reached through a messaging channel that cannot ring.
      ((options.phoneCallsEnabled &&
        !options.groupId &&
        !options.voiceCall &&
        !options.messagingChannelRun &&
        !isBackgroundRunTrigger(options.trigger)) ||
        tool.name !== "call_user") &&
      (options.historyRetrievalEnabled ||
        !["search_history", "read_history", "list_history"].includes(tool.name)) &&
      (!options.messagingChannelRun ||
        (!SCHEDULE_TOOL_NAMES.has(tool.name) &&
          !SKILL_TOOL_NAMES.has(tool.name) &&
          ![
            "remember",
            "save_shared_memory",
            "search_memory_docs",
            "read_memory_doc",
            "save_memory",
            "recall_memory",
            "forget_memory",
            "reflect_memory",
            "task_catalog",
            "board_tickets",
            "task_sync",
          ].includes(tool.name) &&
          !tool.name.startsWith("scratchpad_") &&
          !tool.name.startsWith("ticket_"))),
  );
}

/**
 * The tools one code_mode script may not call: itself, a tool that returns an image (a script
 * cannot show one), a tool that starts work of its own (a helper, a takeover), and the tools that
 * act on the person's own computer, which each deserve a visible step of their own.
 */
const CODE_MODE_EXCLUDED_TOOLS: Readonly<Record<string, true>> = {
  [CODE_MODE]: true,
  run_subagent: true,
  request_takeover: true,
  user_computer_shell: true,
  user_computer_observe: true,
  user_computer_act: true,
};

/**
 * Every tool one code_mode script may call. A write is callable too: each call goes through the
 * same approval gate as a direct call, so a script gets no permission the model lacked.
 */
export function codeModeCallableTools(tools: readonly ConnectorTool[]): ConnectorTool[] {
  return tools.filter(
    (tool) =>
      !Object.hasOwn(CODE_MODE_EXCLUDED_TOOLS, tool.name) &&
      !IMAGE_RETURNING_COMPUTER_TOOLS.has(tool.name),
  );
}

/**
 * Callable tools a code-first run still lists on their own: the ones that talk to the person
 * (their answer ends or pauses the turn) and shell, whose long and streaming work a script's
 * short clock cannot hold.
 */
const CODE_FIRST_DIRECT_TOOLS: ReadonlySet<string> = new Set([
  "shell",
  "ask_user",
  "message_user",
  "request_secret",
  "connect_app",
  "end_call",
  "call_user",
]);

/**
 * What a code-first run lists to the model: code_mode, the tools a script cannot call, and the
 * direct set above. Every other tool stays callable from a script and is simply not listed.
 */
export function codeFirstListedTools(tools: readonly ConnectorTool[]): ConnectorTool[] {
  const scripted = new Set(codeModeCallableTools(tools).map((tool) => tool.name));
  return tools.filter((tool) => CODE_FIRST_DIRECT_TOOLS.has(tool.name) || !scripted.has(tool.name));
}

/** A call that may change something, as opposed to one declared to only read. */
export function isCodeModeWrite(tool: Pick<ConnectorTool, "name" | "readOnly">): boolean {
  return tool.readOnly !== true && !READ_ONLY_AGENT_TOOLS.has(tool.name);
}

export const PAGE_BROWSER_TOOL_NAMES = new Set([
  "browser_navigate",
  "browser_snapshot",
  "browser_act",
]);

export function filterPageBrowserTools<T extends { name: string }>(
  tools: T[],
  pageBrowserAllowed: boolean,
): T[] {
  if (pageBrowserAllowed) return tools;
  return tools.filter((tool) => !PAGE_BROWSER_TOOL_NAMES.has(tool.name));
}

/** The fleet tools this run was offered, the same decision as tool selection. */
export function offeredFleetTools(tools: readonly { name: string }[]): string[] {
  return tools.map((tool) => tool.name).filter((name) => FLEET_TOOL_NAMES_SET.has(name));
}

const FOLLOW_UP_SCHEDULE_TOOLS = ["schedule_create", "schedule_cancel"];
const FOLLOW_UP_SCRATCHPAD_TOOLS = ["scratchpad_add", "scratchpad_complete"];
const FOLLOW_UP_TICKET_TOOLS = ["ticket_create", "ticket_update"];

/**
 * Whether this run can set its own follow-ups. Only a run the owner started can tell what is
 * still open with them; routines, webhooks, channels, subagents and hand-offs from other bots
 * are not, and some of them would need approval for every schedule.
 */
export function followUpsOffered(
  tools: readonly { name: string }[],
  ownerStartedRun: boolean,
): boolean {
  if (!ownerStartedRun) return false;
  const offered = new Set(tools.map((tool) => tool.name));
  const hasSchedule = FOLLOW_UP_SCHEDULE_TOOLS.every((name) => offered.has(name));
  if (!hasSchedule) return false;
  return (
    FOLLOW_UP_SCRATCHPAD_TOOLS.every((name) => offered.has(name)) ||
    FOLLOW_UP_TICKET_TOOLS.every((name) => offered.has(name))
  );
}
