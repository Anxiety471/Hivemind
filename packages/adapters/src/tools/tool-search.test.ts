import { describe, expect, it } from "vitest";
import { rankSearchItems, stemToken, tokenizeSearchText } from "./tool-search.js";

describe("tokenizeSearchText & stemToken", () => {
  it("splits camelCase, acronyms, and punctuation into lowercase tokens", () => {
    expect(tokenizeSearchText("getJiraIssue_v2")).toEqual(["get", "jira", "issue", "v2"]);
    expect(tokenizeSearchText("getHTTPResponse")).toEqual(["get", "http", "response"]);
    expect(tokenizeSearchText("mcp__cloudflare__list-zones")).toEqual([
      "mcp",
      "cloudflare",
      "list",
      "zones",
    ]);
  });

  it("stems common English plurals and verb suffixes deterministically", () => {
    expect(stemToken("tickets")).toBe("ticket");
    expect(stemToken("queries")).toBe("query");
    expect(stemToken("matches")).toBe("match");
    expect(stemToken("running")).toBe("run");
    expect(stemToken("updated")).toBe("updat");
    expect(stemToken("status")).toBe("status");
  });
});

describe("rankSearchItems", () => {
  const catalog = [
    {
      item: "mcp__cloudflare__list_dns_records",
      name: "mcp__cloudflare__list_dns_records",
      aliases: ["list_dns_records"],
      group: "cloudflare",
      params: ["zone_id", "type", "name"],
      description: "List DNS records for a Cloudflare zone.",
    },
    {
      item: "mcp__cloudflare__create_dns_record",
      name: "mcp__cloudflare__create_dns_record",
      aliases: ["create_dns_record"],
      group: "cloudflare",
      params: ["zone_id", "content"],
      description: "Create a DNS record in a Cloudflare zone.",
    },
    {
      item: "mcp__gmail__send_message",
      name: "mcp__gmail__send_message",
      aliases: ["send_message"],
      group: "gmail",
      params: ["to", "subject", "body"],
      description: "Send an email message.",
    },
    {
      item: "mcp__jira__getJiraIssue",
      name: "mcp__jira__getJiraIssue",
      aliases: ["getJiraIssue"],
      group: "jira",
      params: ["issueKey"],
      description: "Fetch a Jira issue by key.",
    },
    {
      item: "ticket_create",
      name: "ticket_create",
      params: ["title", "assignee"],
      description: "Create a ticket on the board.",
    },
  ];

  it("ranks exact names first and splits camelCase queries", () => {
    expect(rankSearchItems(catalog, "getJiraIssue").hits[0]).toBe("mcp__jira__getJiraIssue");
    expect(rankSearchItems(catalog, "JiraIssue").hits[0]).toBe("mcp__jira__getJiraIssue");
  });

  it("matches stemmed plurals, synonyms, and parameter names", () => {
    expect(rankSearchItems(catalog, "zones").hits).toContain("mcp__cloudflare__list_dns_records");
    expect(rankSearchItems(catalog, "add dns").hits[0]).toBe("mcp__cloudflare__create_dns_record");
    expect(rankSearchItems(catalog, "assignee").hits).toEqual(["ticket_create"]);
    expect(rankSearchItems(catalog, "post email").hits[0]).toBe("mcp__gmail__send_message");
  });

  it("recovers from minor typos on fallback without polluting strict matches", () => {
    const typo = rankSearchItems(catalog, "cloudfare dns");
    expect(typo.hits).toContain("mcp__cloudflare__list_dns_records");
    expect(typo.hits).toContain("mcp__cloudflare__create_dns_record");
  });

  it("uses IDF weighting so rare domain terms outweigh generic verbs", () => {
    const items = [
      { item: "list_a", name: "list_a", description: "List items" },
      { item: "list_b", name: "list_b", description: "List items" },
      { item: "get_dns_zone", name: "get_dns_zone", description: "Fetch zone" },
    ];
    expect(rankSearchItems(items, "list zone").hits[0]).toBe("get_dns_zone");
  });

  it("returns empty on blank queries", () => {
    expect(rankSearchItems(catalog, "   ")).toEqual({
      hits: [],
      complete: false,
      queryTokens: [],
    });
  });
});
