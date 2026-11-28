import { listCommitChecks } from "@rakazo/db";
import type { RouterContext } from "./context.js";

export function commitChecksRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  return {
    commitChecks: {
      // Reads only the caller's Space: the commit and pull request pairs name rows in it, nothing else.
      list: authed.commitChecks.list.handler(({ context, input }) =>
        listCommitChecks(deps.prisma, context.actor.spaceId, input),
      ),
    },
  };
}
