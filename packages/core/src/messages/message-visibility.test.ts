import type { ThreadMessage } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { projectMessageReactions } from "./message-reactions.js";
import {
  EMPTY_RESPONSE_FALLBACK_TEXT,
  expandPeerReplies,
  foldPeerReplies,
  isNoResponseMessage,
  jumpTargetId,
  userVisibleMessages,
} from "./message-visibility.js";

function message(id: string, runId: string, blocks: ThreadMessage["blocks"]): ThreadMessage {
  return {
    id,
    threadId: "thread-1",
    seq: 1,
    role: "bot",
    blocks,
    runId,
    createdAt: "2026-08-30T22:00:00.000Z",
  };
}

const received = message("received", "run-peer", [
  {
    kind: "bot_message_received",
    fromBotId: "coder",
    fromBotName: "Coder",
    text: "Done.",
  },
]);

const peerExchange = [
  message("user", "run-user", [{ kind: "text", text: "Please ask Coder." }]),
  message("sent", "run-user", [
    { kind: "bot_message_sent", toBotId: "coder", toBotName: "Coder", text: "Check this." },
  ]),
  received,
  message("activity", "run-peer", [{ kind: "steps", steps: [{ label: "Message bot", count: 1 }] }]),
  message("reply", "run-peer", [{ kind: "text", text: "Sent Coder the endpoints." }]),
  message("answer", "run-user", [{ kind: "text", text: "Coder is checking it." }]),
];

describe("user-visible messages", () => {
  it("hides a delivery that woke the bot but keeps the bot's reply", () => {
    const delivery = {
      ...message("delivery", "run-1", [
        { kind: "delivery" },
        { kind: "text", text: 'Run routine "CRM sync":\nAdd the contact.' },
      ]),
      role: "user",
    };
    const reply = message("reply", "run-1", [{ kind: "text", text: "Added Ada." }]);
    expect(userVisibleMessages([delivery, reply]).map((item) => item.id)).toEqual(["reply"]);
  });

  it("keeps ordinary group replies inline when a member sends a peer message", () => {
    const messages: ThreadMessage[] = [
      { ...message("first", "group-run", [{ kind: "text", text: "Checking" }]), botId: "first" },
      {
        ...message("sent", "group-run", [
          { kind: "bot_message_sent", toBotId: "peer", toBotName: "Peer", text: "Check this" },
        ]),
        botId: "first",
      },
      { ...message("second", "other-run", [{ kind: "text", text: "Agreed" }]), botId: "second" },
      { ...message("final", "group-run", [{ kind: "text", text: "Done" }]), botId: "first" },
    ];
    const transcript = foldPeerReplies(messages, { includePeerReceipts: true });
    expect(transcript.messages).toEqual(messages);
    expect(transcript.folded.size).toBe(0);
    expect(transcript.markerOf.size).toBe(0);
  });

  it("hides peer activity but keeps the bot's text reply when there is no marker to fold it under", () => {
    expect(userVisibleMessages(peerExchange).map((item) => item.id)).toEqual([
      "user",
      "reply",
      "answer",
    ]);
  });

  it("keeps compact peer receipts when includePeerReceipts is set", () => {
    expect(
      userVisibleMessages(peerExchange, { includePeerReceipts: true }).map((item) => item.id),
    ).toEqual(["user", "sent", "received", "answer"]);
  });

  it("folds peer-run replies under their received marker", () => {
    const messages = [
      ...peerExchange,
      message("fallback", "run-peer", [{ kind: "text", text: "Update from Coder: Done." }]),
    ];
    const transcript = foldPeerReplies(messages, { includePeerReceipts: true });

    expect(transcript.messages.map((item) => item.id)).toEqual([
      "user",
      "sent",
      "received",
      "answer",
    ]);
    expect(transcript.folded.get("received")?.map((item) => item.id)).toEqual([
      "reply",
      "fallback",
    ]);
  });

  it("keeps replies about delegated work inline while their peer activity stays hidden", () => {
    const resultFor = (intent: "result" | "status" | "question" | "request" | "fyi") => [
      message("user", "run-user", [{ kind: "text", text: "Please ask Coder." }]),
      message("sent", "run-user", [
        { kind: "bot_message_sent", toBotId: "coder", toBotName: "Coder", text: "Check this." },
      ]),
      {
        ...message("received", "run-peer", [
          {
            kind: "bot_message_received",
            fromBotId: "coder",
            fromBotName: "Coder",
            text: "The endpoint returns 200.",
            intent,
          },
        ]),
        replyToMessageId: "sent",
      },
      message("activity", "run-peer", [
        { kind: "steps", steps: [{ label: "Message bot", count: 1 }] },
      ]),
      message("relay", "run-peer", [{ kind: "text", text: "Coder confirmed it returns 200." }]),
    ];

    // Results, statuses, and the helper asking back about the delegated work all wake the bot to
    // speak to the user. An FYI never threads back, but it is not new work either.
    const unthreaded = (intent: "fyi" | "request" | "question") =>
      resultFor(intent).map((item) => ({ ...item, replyToMessageId: undefined }));
    for (const messages of [
      resultFor("result"),
      resultFor("status"),
      resultFor("question"),
      resultFor("request"),
      unthreaded("fyi"),
    ]) {
      const transcript = foldPeerReplies(messages, { includePeerReceipts: true });
      // Threaded back to "Messaged Coder", the marker merges into that receipt; an FYI keeps it.
      expect(transcript.messages.map((item) => item.id)).toEqual(
        messages[2]?.replyToMessageId
          ? ["user", "sent", "relay"]
          : ["user", "sent", "received", "relay"],
      );
      expect(transcript.folded.size).toBe(0);
    }
    // With the receipt outside the loaded page, the marker stays so the exchange is still reachable.
    expect(
      foldPeerReplies(
        resultFor("result").filter((item) => item.id !== "sent"),
        { includePeerReceipts: true },
      ).messages.map((item) => item.id),
    ).toEqual(["user", "received", "relay"]);
    // A jump to the dropped marker (a search hit on its text) lands on the receipt it merged into.
    const merged = foldPeerReplies(resultFor("result"), { includePeerReceipts: true });
    expect(jumpTargetId(merged, "received")).toBe("sent");
    expect(jumpTargetId(merged, "relay")).toBe("relay");
    // New work from another bot: the reply goes back to that bot, so it folds.
    for (const intent of ["request", "question"] as const) {
      expect(
        foldPeerReplies(unthreaded(intent), { includePeerReceipts: true })
          .folded.get("received")
          ?.map((item) => item.id),
      ).toEqual(["relay"]);
    }
    // Sidebar previews show the relay, the bot's own reply, but never another bot's new work.
    expect(
      userVisibleMessages(resultFor("result"), { includeDelegatedReplyText: false }).map(
        (item) => item.id,
      ),
    ).toEqual(["user", "relay"]);
    expect(
      userVisibleMessages(unthreaded("request"), { includeDelegatedReplyText: false }).map(
        (item) => item.id,
      ),
    ).toEqual(["user"]);
  });

  it("folds peer-run file replies under their received marker", () => {
    const messages = [
      ...peerExchange,
      message("file_reply", "run-peer", [
        {
          kind: "file",
          artifactId: "file1",
          mimeType: "application/pdf",
          name: "test.pdf",
          size: 100,
        },
      ]),
      message("image_reply", "run-peer", [
        { kind: "image", artifactId: "img1", mimeType: "image/png", name: "test.png" },
      ]),
    ];
    const transcript = foldPeerReplies(messages, { includePeerReceipts: true });

    expect(transcript.messages.map((item) => item.id)).toEqual([
      "user",
      "sent",
      "received",
      "answer",
    ]);
    expect(transcript.folded.get("received")?.map((item) => item.id)).toEqual([
      "reply",
      "file_reply",
      "image_reply",
    ]);
  });

  it("folds chart-only peer replies under their received marker and expands them", () => {
    const chartReply = message("chart_reply", "run-peer", [
      { kind: "chart", name: "Results", spec: {}, data: [] },
    ]);
    const activity = message("activity", "run-peer", [
      { kind: "steps", steps: [{ label: "Work", count: 1 }] },
    ]);
    const transcript = foldPeerReplies([received, activity, chartReply], {
      includePeerReceipts: true,
    });

    expect(transcript.messages).toEqual([received]);
    expect(transcript.folded.get("received")).toEqual([chartReply]);
    expect(transcript.markerOf.get("chart_reply")).toBe("received");
    expect(expandPeerReplies(transcript, new Set())).toEqual([received]);
    expect(expandPeerReplies(transcript, new Set(["received"]))).toEqual([received, chartReply]);
  });

  it("folds page-only peer replies under their received marker", () => {
    const pageReply = message("page_reply", "run-peer", [
      { kind: "page", pageId: "page-1", version: 1, title: "Results" },
    ]);
    const transcript = foldPeerReplies([received, pageReply], { includePeerReceipts: true });

    expect(transcript.messages).toEqual([received]);
    expect(transcript.folded.get("received")).toEqual([pageReply]);
  });

  it("keeps chart-only relays inline", () => {
    const relayReceipt = { ...received, replyToMessageId: "sent" };
    const chartReply = message("chart_reply", "run-peer", [
      { kind: "chart", name: "Results", spec: {}, data: [] },
    ]);
    const transcript = foldPeerReplies([relayReceipt, chartReply], {
      includePeerReceipts: true,
      includeDelegatedReplyText: false,
    });

    expect(transcript.messages).toEqual([relayReceipt, chartReply]);
    expect(transcript.folded.size).toBe(0);
  });

  it("hides chart-only background replies even when their peer receipt is expanded", () => {
    const chartReply = message("chart_reply", "run-peer", [
      { kind: "chart", name: "Results", spec: {}, data: [] },
    ]);
    const transcript = foldPeerReplies([received, chartReply], {
      includePeerReceipts: true,
      backgroundRunIds: ["run-peer"],
    });

    expect(transcript.messages).toEqual([]);
    expect(transcript.folded.size).toBe(0);
    expect(transcript.markerOf.size).toBe(0);
    expect(expandPeerReplies(transcript, new Set(["received"]))).toEqual([]);
  });

  it("keeps peer-run user-input cards inline while folding the reply", () => {
    const messages = [
      ...peerExchange,
      message("ask", "run-peer", [{ kind: "ask", text: "Pick one", status: "pending" }]),
      message("choice", "run-peer", [
        { kind: "choice", question: "Which?", options: [{ id: "a", letter: "A", label: "A" }] },
      ]),
    ];
    const transcript = foldPeerReplies(messages, { includePeerReceipts: true });

    expect(transcript.messages.map((item) => item.id)).toEqual([
      "user",
      "sent",
      "received",
      "answer",
      "ask",
      "choice",
    ]);
    expect(transcript.folded.get("received")?.map((item) => item.id)).toEqual(["reply"]);
  });

  it("draws expanded folds right after their marker", () => {
    const transcript = foldPeerReplies(peerExchange, { includePeerReceipts: true });

    expect(expandPeerReplies(transcript, new Set()).map((item) => item.id)).toEqual([
      "user",
      "sent",
      "received",
      "answer",
    ]);
    expect(expandPeerReplies(transcript, new Set(["received"])).map((item) => item.id)).toEqual([
      "user",
      "sent",
      "received",
      "reply",
      "answer",
    ]);
  });

  it("resolves a folded message to the marker it folds under", () => {
    const transcript = foldPeerReplies(peerExchange, { includePeerReceipts: true });

    expect(transcript.markerOf.get("reply")).toBe("received");
    expect(transcript.markerOf.has("answer")).toBe(false);
    expect(transcript.markerOf.has("received")).toBe(false);
  });

  it("folds a reaction to a folded reply with it, and a text reply stays inline", () => {
    const reaction: ThreadMessage = {
      ...message("reaction", "", [{ kind: "text", text: "👍" }]),
      runId: undefined,
      role: "user",
      replyToMessageId: "reply",
    };
    const textReply: ThreadMessage = {
      ...message("quote", "", [{ kind: "text", text: "Thanks for this" }]),
      runId: undefined,
      role: "user",
      replyToMessageId: "reply",
    };
    const transcript = foldPeerReplies([...peerExchange, reaction, textReply], {
      includePeerReceipts: true,
    });

    expect(transcript.messages.map((item) => item.id)).toEqual([
      "user",
      "sent",
      "received",
      "answer",
      "quote",
    ]);
    expect(transcript.markerOf.get("reaction")).toBe("received");
    const collapsed = projectMessageReactions(expandPeerReplies(transcript, new Set()));
    expect(collapsed.visibleMessages.map((item) => item.id)).not.toContain("reaction");
    const expanded = projectMessageReactions(expandPeerReplies(transcript, new Set(["received"])));
    expect(expanded.visibleMessages.map((item) => item.id)).toEqual([
      "user",
      "sent",
      "received",
      "reply",
      "answer",
      "quote",
    ]);
    expect(expanded.reactions.get("reply")?.get("👍")).toBe(1);
  });

  describe("a human message in a peer run", () => {
    const ask = message("ask", "run-peer", [
      { kind: "ask", text: "Which city should I use?", status: "pending" },
    ]);
    const human = (id: string, text: string, replyToMessageId?: string): ThreadMessage => ({
      ...message(id, "run-peer", [{ kind: "text", text }]),
      role: "user",
      replyToMessageId,
    });

    it("stays visible when it answers the run's ask", () => {
      const transcript = foldPeerReplies([received, ask, human("paris", "Paris")], {
        includePeerReceipts: true,
      });

      expect(transcript.messages.map((item) => item.id)).toEqual(["received", "ask", "paris"]);
      expect(transcript.markerOf.has("paris")).toBe(false);
    });

    it("keeps a reaction to the run's inline ask counted on the ask", () => {
      const transcript = foldPeerReplies([received, ask, human("thumbs", "👍", "ask")], {
        includePeerReceipts: true,
      });

      expect(transcript.messages.map((item) => item.id)).toEqual(["received", "ask", "thumbs"]);
      const view = projectMessageReactions(expandPeerReplies(transcript, new Set()));
      expect(view.visibleMessages.map((item) => item.id)).toEqual(["received", "ask"]);
      expect(view.reactions.get("ask")?.get("👍")).toBe(1);
    });

    it("stays visible as steering while the bot's own reply still folds", () => {
      const transcript = foldPeerReplies([...peerExchange, human("steer", "Use the staging API")], {
        includePeerReceipts: true,
      });

      expect(transcript.messages.map((item) => item.id)).toEqual([
        "user",
        "sent",
        "received",
        "answer",
        "steer",
      ]);
      expect(transcript.folded.get("received")?.map((item) => item.id)).toEqual(["reply"]);
    });

    it("stays out of sidebar previews, as before", () => {
      expect(
        userVisibleMessages([...peerExchange, ask, human("paris", "Paris")], {
          includeDelegatedReplyText: false,
        }).map((m) => m.id),
      ).toEqual(["user", "answer", "ask"]);
    });
  });

  it("keeps sidebar previews ask-only", () => {
    expect(
      userVisibleMessages(peerExchange, { includeDelegatedReplyText: false }).map((m) => m.id),
    ).toEqual(["user", "answer"]);
  });

  it("uses authoritative peer run ids when the receipt is outside the loaded page", () => {
    const messages = [
      message("activity", "run-peer", [
        { kind: "steps", steps: [{ label: "Echoed peer reply", count: 1 }] },
      ]),
      message("reply", "run-peer", [{ kind: "text", text: "Echoed peer reply" }]),
      message("answer", "run-user", [{ kind: "text", text: "Visible answer" }]),
    ];

    expect(
      userVisibleMessages(messages, { knownPeerRunIds: ["run-peer"] }).map((item) => item.id),
    ).toEqual(["reply", "answer"]);
  });

  it("keeps a peer-run ask card and text reply while hiding other peer activity", () => {
    const messages = [
      message("ask", "run-peer", [
        {
          kind: "ask",
          text: "Pick one",
          status: "pending",
          actions: [{ id: "a", label: "A" }],
        },
      ]),
      message("activity", "run-peer", [{ kind: "steps", steps: [{ label: "Work", count: 1 }] }]),
      message("reply", "run-peer", [{ kind: "text", text: "Peer body" }]),
      message("answer", "run-user", [{ kind: "text", text: "Visible answer" }]),
    ];

    expect(
      userVisibleMessages(messages, { knownPeerRunIds: ["run-peer"] }).map((item) => item.id),
    ).toEqual(["ask", "reply", "answer"]);
  });

  it("hides background ticket-run output except user messages and user-input cards", () => {
    const background = [
      message("wake", "run-ticket", [{ kind: "text", text: "Ticket check prompt" }]),
      {
        ...message("delivery", "run-ticket", [
          { kind: "delivery" },
          { kind: "text", text: "Work on ticket TASK-1." },
        ]),
        role: "user" as const,
      },
      {
        ...message("user-followup", "run-ticket", [{ kind: "text", text: "Hello?" }]),
        role: "user" as const,
      },
      message("steps", "run-ticket", [
        { kind: "steps", steps: [{ label: "Ticket comment", count: 2 }] },
      ]),
      {
        ...message("progress", "run-ticket", [{ kind: "text", text: "Working on it" }]),
        clientNonce: "user-progress:run-ticket:0",
      },
      message("ask", "run-ticket", [{ kind: "ask", text: "Choose" }]),
      message("computer", "run-ticket", [
        { kind: "computer", state: "Needs you", text: "Sign in" },
      ]),
      message("approval", "run-ticket", [
        {
          kind: "mcp_approval",
          serverId: "server-1",
          name: "Test",
          transport: "streamable_http",
          endpoint: "https://example.com/mcp",
          needsOAuth: true,
          status: "pending",
        },
      ]),
      message("connect", "run-ticket", [
        {
          kind: "app_connect",
          provider: "gmail",
          name: "Gmail",
          description: "",
          logo: null,
          status: "pending",
        },
      ]),
      message("final", "run-ticket", [{ kind: "text", text: "Done, closed the ticket." }]),
      message("user", "run-user", [{ kind: "text", text: "Visible answer" }]),
    ];

    expect(
      userVisibleMessages(background, { backgroundRunIds: ["run-ticket"] }).map((m) => m.id),
    ).toEqual(["user-followup", "ask", "computer", "approval", "connect", "user"]);
  });
});

describe("no-response messages", () => {
  const fallback = { kind: "text", text: EMPTY_RESPONSE_FALLBACK_TEXT } as const;
  const thinking: ThreadMessage["blocks"][number] = {
    kind: "thinking",
    durationMs: 0,
    lines: ["..."],
  };
  const user = (id: string, blocks: ThreadMessage["blocks"]) => ({
    ...message(id, "run-user", blocks),
    role: "user" as const,
  });

  it("hides a persisted fallback text reply", () => {
    const row = message("empty", "run-1", [fallback]);
    expect(isNoResponseMessage(row)).toBe(true);
    expect(foldPeerReplies([row]).messages).toEqual([]);
    expect(userVisibleMessages([row])).toEqual([]);
  });

  it("hides thinking followed by the fallback text", () => {
    const row = message("empty", "run-1", [thinking, fallback]);
    expect(userVisibleMessages([row])).toEqual([]);
  });

  it("hides fallback text split across blocks or padded with whitespace", () => {
    const split = message("split", "run-1", [
      { kind: "text", text: "No response." },
      { kind: "text", text: " Try again." },
    ]);
    const padded = message("padded", "run-1", [
      { kind: "text", text: "  No response. Try again.\n " },
    ]);
    expect(userVisibleMessages([split, padded])).toEqual([]);
  });

  it("hides a thinking-only message", () => {
    const row = message("thinking-only", "run-1", [thinking]);
    expect(isNoResponseMessage(row)).toBe(true);
    expect(userVisibleMessages([row])).toEqual([]);
  });

  it("hides a message with no blocks or only whitespace text", () => {
    const empty = message("empty", "run-1", []);
    const blank = message("blank", "run-1", [{ kind: "text", text: "   " }]);
    expect(userVisibleMessages([empty, blank])).toEqual([]);
  });

  it("keeps the receipt and drops only the no-response reply after it", () => {
    const sent = message("sent", "run-1", [
      { kind: "bot_message_sent", toBotId: "grok", toBotName: "Grok Bot", text: "Hi" },
    ]);
    const empty = message("empty", "run-1", [fallback]);
    expect(
      foldPeerReplies([sent, empty], { includePeerReceipts: true }).messages.map((m) => m.id),
    ).toEqual(["sent"]);
    expect(
      userVisibleMessages([sent, empty], { includePeerReceipts: true }).map((m) => m.id),
    ).toEqual(["sent"]);
  });

  it("keeps a live progress placeholder visible while the bot works", () => {
    const live = {
      ...message("progress:run-1", "run-1", [thinking]),
    };
    expect(isNoResponseMessage(live)).toBe(false);
    expect(userVisibleMessages([live]).map((m) => m.id)).toEqual(["progress:run-1"]);
  });

  it("keeps a user message that repeats the fallback text", () => {
    const row = user("user-fallback", [fallback]);
    expect(isNoResponseMessage(row)).toBe(false);
    expect(userVisibleMessages([row]).map((m) => m.id)).toEqual(["user-fallback"]);
  });

  it("keeps a bot message that quotes the fallback text in prose", () => {
    const row = message("quoted", "run-1", [
      { kind: "text", text: 'The log said "No response. Try again."' },
    ]);
    expect(isNoResponseMessage(row)).toBe(false);
    expect(userVisibleMessages([row]).map((m) => m.id)).toEqual(["quoted"]);
  });

  it("keeps bot messages with any other visible content", () => {
    const kept: ThreadMessage["blocks"][] = [
      [thinking, { kind: "steps", steps: [{ label: "Search", count: 1 }] }],
      [
        {
          kind: "ask",
          question: "Which?",
          options: [],
        } as unknown as ThreadMessage["blocks"][number],
      ],
      [{ kind: "file", file: { name: "a.txt" } } as unknown as ThreadMessage["blocks"][number]],
      [{ kind: "image", image: {} } as unknown as ThreadMessage["blocks"][number]],
      [{ kind: "chart", chart: {} } as unknown as ThreadMessage["blocks"][number]],
      [{ kind: "page", page: {} } as unknown as ThreadMessage["blocks"][number]],
      [{ kind: "subagent" } as unknown as ThreadMessage["blocks"][number]],
      [{ kind: "child_bot" } as unknown as ThreadMessage["blocks"][number]],
      [{ kind: "bot_message_sent", toBotId: "b", toBotName: "B", text: "Hi" }],
      [{ kind: "bot_message_received", fromBotId: "b", fromBotName: "B", text: "Hi" }],
    ];
    for (const blocks of kept) {
      const row = message("kept", "run-1", blocks);
      expect(isNoResponseMessage(row)).toBe(false);
    }
  });

  it("treats a kinds-only outline stand-in as unknown, not empty", () => {
    const outline = message("outline", "run-1", [{ kind: "text" }] as ThreadMessage["blocks"]);
    expect(isNoResponseMessage(outline)).toBe(false);
  });
});
