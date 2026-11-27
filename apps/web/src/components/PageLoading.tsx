import { useLingui } from "@lingui/react/macro";
import { Spinner } from "@rakazo/ui-web";
import { SlowHint } from "./ai/primitives";

/**
 * A whole-page wait. The spinner fades in late, so a quick load paints nothing in between, and a
 * load that lasts says so calmly a little later.
 */
export function PageLoading(props: React.ComponentPropsWithoutRef<"div">) {
  const { t } = useLingui();
  return (
    <div className="grid h-full place-items-center bg-background" {...props}>
      <span className="flex flex-col items-center gap-3">
        <span className="animate-in fade-in-0 fill-mode-both delay-500 duration-300 motion-reduce:animate-none">
          <Spinner className="size-5 text-muted-foreground" aria-label={t`Loading…`} />
        </span>
        <SlowHint pending />
      </span>
    </div>
  );
}
