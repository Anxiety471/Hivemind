import { Trans } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { Navigate } from "react-router-dom";
import { PageHeader } from "../../components/PageHeader";
import { PageLoading } from "../../components/PageLoading";
import { WindowChrome } from "../../components/WindowChrome";
import { useSpaceQueries } from "../../lib/query/query";
import { PluginSubmissionsPanel } from "./PluginSubmissionsPanel";

export function AdminPluginsPage() {
  const me = useQuery(useSpaceQueries().me.queryOptions());
  if (me.isPending) return <PageLoading />;
  if (!me.data?.isAdmin) return <Navigate to="/app" replace />;
  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-background text-foreground">
      <WindowChrome />
      <PageHeader title={<Trans>Plugin submissions</Trans>} />
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-6">
          <PluginSubmissionsPanel />
        </div>
      </main>
    </div>
  );
}
