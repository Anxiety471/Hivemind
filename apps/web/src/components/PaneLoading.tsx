import { useLingui } from "@lingui/react/macro";
import { cn, Spinner } from "@rakazo/ui-web";
import { SlowHint } from "./ai/primitives";

/**
 * A wait inside a pane, never a blank one: the spinner fades in after a moment, and a wait that
 * lasts says so calmly a little later. It fills whatever height its pane gives it.
 */
export function PaneLoading({ className }: { className?: string }) {
  const { t } = useLingui();
  return (
    <div className={cn("grid flex-1 place-items-center", className)}>
      <span className="flex flex-col items-center gap-3">
        <span className="animate-in fade-in-0 fill-mode-both delay-300 duration-300 motion-reduce:animate-none">
          <Spinner className="size-5 text-muted-foreground" aria-label={t`Loading…`} />
        </span>
        <SlowHint pending />
      </span>
    </div>
  );
}
