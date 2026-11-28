export function ticketWakePrompt(ticket: string, note?: string): string {
  const prompt = `Work on ticket ${ticket}. Read it with ticket_get. Keep progress in ticket comments and update its status with ticket_update. When user input is needed, set status to blocked (or review), tag @user, and include decision with a short question, 3 concise options, and 1 recommended option.`;
  return note ? `${prompt} ${note}` : prompt;
}

export function purchaseWakePrompt(purchaseId: string, status: string): string {
  return `Purchase ${purchaseId} is ${status}. Use purchase_status to continue.`;
}

export function mediaVideoWakePrompt(jobId: string, completed: boolean): string {
  return completed
    ? `Video job ${jobId} finished and is attached to the chat.`
    : `Video job ${jobId} failed. Do not resubmit unless the user asks.`;
}

export function cloudAgentWakePrompt(agentId: string, status: string): string {
  return `Cloud agent ${agentId} is ${status}. Use cloud_agent_status to inspect its result.`;
}

/** Appended to a cloud agent's task when the bot asks it to open a pull request. */
export const CLOUD_AGENT_OPEN_PR = "When you finish, open a pull request with your changes.";
