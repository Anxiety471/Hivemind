import { navLinkSandbox } from "@rakazo/contracts";
import { useQuery } from "@tanstack/react-query";
import { Navigate, useParams } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
import { PageLoading } from "../components/PageLoading";
import { desktopBridge } from "../lib/platform/desktop";
import { rpc } from "../lib/query/rpc";
import { WindowChrome } from "./WindowChrome";

export function NavLinkPage() {
  const { linkId } = useParams();
  // The desktop renderer is not served from the deployment's origin, so the path would miss.
  const desktop = Boolean(desktopBridge());
  const me = useQuery({
    queryKey: ["me", "nav-links"],
    queryFn: () => rpc.me(),
    enabled: !desktop,
  });
  if (desktop) return <Navigate to="/app" replace />;
  if (me.isPending) return <PageLoading />;
  // An API older than this field omits it, and replies are not parsed through MeSchema.
  const link = me.data?.navLinks?.find((candidate) => candidate.id === linkId);
  if (!link) return <Navigate to="/app" replace />;
  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-background text-foreground">
      <WindowChrome />
      <PageHeader title={link.label} />
      <iframe
        key={link.id}
        title={link.label}
        src={link.path}
        sandbox={navLinkSandbox(link)}
        referrerPolicy="no-referrer"
        className="min-h-0 w-full flex-1 border-0"
      />
    </div>
  );
}
