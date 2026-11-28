import type { CommitChecksSource, CommitCheckTarget } from "@rakazo/chat-ui/web";
import { useQuery } from "@tanstack/react-query";
import { useSpaceQueries } from "../../lib/query/query";

/**
 * Reads the checks of the commit or pull request a message link names. The read is the Space's
 * own `commitChecks.list`, and the app's live stream re-reads it when a check changes.
 */
function useCommitChecks(target: CommitCheckTarget) {
  const queries = useSpaceQueries();
  const input =
    target.kind === "commit"
      ? {
          commits: [{ repository: target.repository, sha: target.sha }],
          pullRequests: [],
        }
      : {
          commits: [],
          pullRequests: [{ repository: target.repository, number: target.number }],
        };
  const { data } = useQuery(queries.commitChecks.list.queryOptions({ input }));
  if (!data) return undefined;
  return target.kind === "commit" ? data.commits[0]?.checks : data.pullRequests[0]?.checks;
}

export const commitChecksSource: CommitChecksSource = { use: useCommitChecks };
