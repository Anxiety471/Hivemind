import { describe, expect, it } from "vitest";
import { builtinAgentTools } from "./builtin.tool-definition.js";

describe("message_bot definition", () => {
  const tool = builtinAgentTools.find((candidate) => candidate.name === "message_bot");

  it("requires an explicit intent alongside the message", () => {
    expect(tool?.inputSchema.required).toEqual(["message", "intent"]);
  });

  it("offers the five intents, with fyi described as needing no action", () => {
    const properties = tool?.inputSchema.properties as Record<string, unknown> | undefined;
    const intent = properties?.intent as { enum: string[]; description: string };
    expect(intent.enum).toEqual(["request", "result", "question", "status", "fyi"]);
    expect(intent.description).toContain("fyi: informational heads-up only");
    expect(intent.description).toContain("takes no action");
    expect(intent.description).not.toContain("Defaults to request");
  });
});
