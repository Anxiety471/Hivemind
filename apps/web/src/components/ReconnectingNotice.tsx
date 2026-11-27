import { useLingui } from "@lingui/react/macro";
import { useServerReachable } from "../lib/query/connection-state";
import { LoadingState } from "./ai/primitives";

/**
 * The one place the app says a request could not reach the server. It floats over the top of the
 * screen without taking input, so the last data painted stays readable while the retries run, and
 * it leaves the moment any request answers again.
 */
export function ReconnectingNotice() {
  const { t } = useLingui();
  const reachable = useServerReachable();
  if (reachable) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-50 flex justify-center px-4">
      <div
        role="status"
        aria-live="polite"
        className="animate-in fade-in-0 slide-in-from-top-1 rounded-full border border-warning/40 bg-card/95 px-3 py-1.5 shadow-sm backdrop-blur duration-300 motion-reduce:animate-none"
      >
        <LoadingState label={t`Reconnecting…`} />
      </div>
    </div>
  );
}
