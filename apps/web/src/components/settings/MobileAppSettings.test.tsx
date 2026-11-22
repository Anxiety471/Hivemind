// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({ buttonVariants: () => "" }));

import { ANDROID_APP_STORE_URL, IOS_APP_STORE_URL } from "@rakazo/contracts";
import { MobileAppSettings } from "./MobileAppSettings";

afterEach(() => {
  document.body.innerHTML = "";
});

async function render(links?: Parameters<typeof MobileAppSettings>[0]["links"]) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<MobileAppSettings links={links} />);
  });
  return {
    links: () =>
      [
        ...container.querySelectorAll<HTMLAnchorElement>("[data-testid='mobile-app-settings'] a"),
      ].map((link) => ({
        href: link.getAttribute("href"),
        label: link.textContent,
        target: link.getAttribute("target"),
        rel: link.getAttribute("rel"),
      })),
  };
}

it("offers the app's store pages when the deployment publishes no build", async () => {
  const view = await render();
  expect(view.links()).toEqual([
    {
      href: ANDROID_APP_STORE_URL,
      label: "Download for Android",
      target: "_blank",
      rel: "noopener noreferrer",
    },
    {
      href: IOS_APP_STORE_URL,
      label: "Download for iPhone",
      target: "_blank",
      rel: "noopener noreferrer",
    },
  ]);
});

it("points each platform at the deployment's own build", async () => {
  const view = await render({
    android: "https://example.test/rakazo.apk",
    ios: "https://example.test/app",
  });
  expect(view.links().map((link) => link.href)).toEqual([
    "https://example.test/rakazo.apk",
    "https://example.test/app",
  ]);
});

it("keeps the store page on a platform the deployment leaves out", async () => {
  const view = await render({ android: "https://example.test/rakazo.apk" });
  expect(view.links().map((link) => link.href)).toEqual([
    "https://example.test/rakazo.apk",
    IOS_APP_STORE_URL,
  ]);
});
