import { Trans } from "@lingui/react/macro";
import type { MobileAppLinks } from "@rakazo/contracts";
import { mobileAppUrl } from "@rakazo/contracts";
import { buttonVariants } from "@rakazo/ui-web";
import { SettingsGroup } from "./SettingsRows";

/**
 * Where to get the mobile app: this deployment's own build when it publishes one, else the app's
 * store page, so both platforms always have somewhere to go.
 */
export function MobileAppSettings({ links }: { links?: MobileAppLinks }) {
  return (
    <SettingsGroup title={<Trans>Mobile app</Trans>} data-testid="mobile-app-settings">
      <div className="flex flex-wrap gap-2 px-4 py-3">
        <a
          href={mobileAppUrl(links, "android")}
          target="_blank"
          rel="noopener noreferrer"
          className={buttonVariants({ variant: "secondary", size: "sm" })}
        >
          <Trans>Download for Android</Trans>
        </a>
        <a
          href={mobileAppUrl(links, "ios")}
          target="_blank"
          rel="noopener noreferrer"
          className={buttonVariants({ variant: "secondary", size: "sm" })}
        >
          <Trans>Download for iPhone</Trans>
        </a>
      </div>
    </SettingsGroup>
  );
}
