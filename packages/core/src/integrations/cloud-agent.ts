import type { MessageBlock } from "@rakazo/contracts";
import { httpsUrl } from "../primitives/links.js";

/** The https link a cloud agent's payload carried, if any. */
export const cloudAgentHttpsUrl = httpsUrl;

export function cloudAgentBlockFromPayload(
  payload: Record<string, unknown>,
): Extract<MessageBlock, { kind: "cloud_agent" }> {
  const status = payload.status;
  return {
    kind: "cloud_agent",
    agentId: String(payload.agentId ?? ""),
    title: String(payload.title ?? "Cloud agent"),
    status:
      status === "finished" || status === "failed" || status === "cancelled" || status === "expired"
        ? status
        : "running",
    url: cloudAgentHttpsUrl(String(payload.url ?? "")) ?? "",
    ...(payload.branch ? { branch: String(payload.branch) } : {}),
    ...(cloudAgentHttpsUrl(String(payload.prUrl ?? "")) ? { prUrl: String(payload.prUrl) } : {}),
    ...(payload.latestRunId ? { latestRunId: String(payload.latestRunId) } : {}),
  };
}
