import { useLingui } from "@lingui/react/macro";
import { buttonVariants } from "@rakazo/ui-web";
import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";

/** The header of a page that fills the window: back link, title and optional trailing actions. */
export function PageHeader({
  title,
  actions,
  backTo = "/app",
}: {
  title: ReactNode;
  actions?: ReactNode;
  backTo?: string;
}) {
  const { t } = useLingui();
  return (
    <header className="flex items-center gap-3 border-b px-4 py-3">
      <Link
        to={backTo}
        className={buttonVariants({ variant: "ghost", size: "icon" })}
        aria-label={t`Back`}
      >
        <ChevronLeft />
      </Link>
      <h1 className="flex-1 text-heading3 font-medium">{title}</h1>
      {actions}
    </header>
  );
}
