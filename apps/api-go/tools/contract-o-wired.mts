/**
 * Lane O's live streams, wired into the full contract suite where its runner can hold them: a
 * request that is refused before the stream opens is an ordinary response (400 for the input, 401
 * for a missing session), so those paths are compared like any other case. Every frame — replay,
 * live, alerts, calls — is compared by tools/contract-o-streams.mts, which keeps a stream open on
 * both sides; this runner cannot, so a valid input here would never answer.
 */
import type { Case } from "./contract.mts";

export function oStreamErrorCases(): Case[] {
  return [
    {
      name: "o-subscribe-both-targets",
      procedure: "threads.subscribe",
      input: { botId: "__bot__", groupId: "__group__", cursor: -1 },
      declines: false,
    },
    {
      name: "o-subscribe-no-target",
      procedure: "threads.subscribe",
      input: { cursor: -1 },
      declines: false,
    },
    {
      name: "o-subscribe-cursor-below-min",
      procedure: "threads.subscribe",
      input: { botId: "__bot__", cursor: -2 },
      declines: false,
    },
    {
      name: "o-subscribe-cursor-fraction",
      procedure: "threads.subscribe",
      input: { botId: "__bot__", cursor: 1.5 },
      declines: false,
    },
    {
      name: "o-subscribe-empty-bot",
      procedure: "threads.subscribe",
      input: { botId: "", cursor: -1 },
      declines: false,
    },
    {
      name: "o-subscribe-anonymous",
      procedure: "threads.subscribe",
      input: { botId: "__bot__", cursor: -1 },
      anonymous: true,
      declines: false,
    },
    {
      name: "o-helper-subscribe-empty-thread",
      procedure: "threads.helperSubscribe",
      input: { threadId: "", cursor: -1 },
      declines: false,
    },
    {
      name: "o-helper-subscribe-cursor-fraction",
      procedure: "threads.helperSubscribe",
      input: { threadId: "nobody-thread", cursor: 0.5 },
      declines: false,
    },
    {
      name: "o-helper-subscribe-anonymous",
      procedure: "threads.helperSubscribe",
      input: { threadId: "nobody-thread", cursor: -1 },
      anonymous: true,
      declines: false,
    },
    {
      name: "o-notifications-subscribe-anonymous",
      procedure: "notifications.subscribe",
      input: {},
      anonymous: true,
      declines: false,
    },
    {
      name: "o-notifications-subscribeCalls-anonymous",
      procedure: "notifications.subscribeCalls",
      input: {},
      anonymous: true,
      declines: false,
    },
  ];
}
