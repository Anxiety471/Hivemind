import { useLingui } from "@lingui/react/macro";
import {
  DARWIN_WINDOW_CONTROLS_WIDTH_PX,
  desktopBridge,
  windowChromeKind,
} from "../lib/platform/desktop";

// macOS traffic-light colours: fixed platform colours, deliberately not theme tokens.
export const TRAFFIC_LIGHT_CLOSE = "#FF5F57";
export const TRAFFIC_LIGHT_MINIMIZE = "#FEBC2E";
export const TRAFFIC_LIGHT_FULLSCREEN = "#28C840";

function chromeClass(base: string, className?: string) {
  return className ? `${base} ${className}` : base;
}

export function WindowChrome({ className }: { className?: string }) {
  const { t } = useLingui();
  const desktop = desktopBridge();
  const kind = windowChromeKind(desktop);
  if (kind === "spacer" || kind === "darwin") {
    return (
      <div
        className={chromeClass(
          kind === "darwin" ? "app-drag h-3 shrink-0" : "h-3 shrink-0",
          className,
        )}
        style={{ width: DARWIN_WINDOW_CONTROLS_WIDTH_PX }}
        aria-hidden="true"
      />
    );
  }
  return (
    <div className={chromeClass("app-drag flex shrink-0 gap-[7px]", className)}>
      <button
        type="button"
        className="app-no-drag h-3 w-3 rounded-full"
        style={{ backgroundColor: TRAFFIC_LIGHT_CLOSE }}
        aria-label={t`Close`}
        onClick={() => void desktop?.window.close()}
      />
      <button
        type="button"
        className="app-no-drag h-3 w-3 rounded-full"
        style={{ backgroundColor: TRAFFIC_LIGHT_MINIMIZE }}
        aria-label={t`Minimize`}
        onClick={() => void desktop?.window.minimize()}
      />
      <button
        type="button"
        className="app-no-drag h-3 w-3 rounded-full"
        style={{ backgroundColor: TRAFFIC_LIGHT_FULLSCREEN }}
        aria-label={t`Fullscreen`}
        onClick={() => void desktop?.window.toggleMaximize()}
      />
    </div>
  );
}
