// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  contentUrl: vi.fn(
    (artifactId: string, options?: { download?: boolean }) =>
      `/api/v1/files/${artifactId}/content${options?.download ? "?download=1" : ""}`,
  ),
  anchors: [] as { href: string; download: string }[],
}));

vi.mock("../../../lib/files/file-client", () => ({
  fileContentUrl: mocks.contentUrl,
}));
vi.mock("@lingui/react/macro", () => {
  const t = (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((text, part, index) => text + part + (values[index] ?? ""), "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
}));

import { ArtifactImage } from "./message-cards";

let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.contentUrl.mockClear();
  mocks.anchors.length = 0;
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    mocks.anchors.push({ href: this.href, download: this.download });
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("downloads the image thumbnail through the attachment content URL", async () => {
  await act(async () => root?.render(<ArtifactImage artifactId="photo-1" name="shot.png" />));
  expect(container.querySelector("img")?.getAttribute("src")).toBe("/api/v1/files/photo-1/content");
  const button = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Download shot.png"]',
  );
  if (!button) throw new Error("download button did not render");
  await act(async () => button.click());
  expect(mocks.contentUrl).toHaveBeenCalledWith("photo-1", { download: true });
  expect(mocks.anchors).toEqual([
    { href: "http://localhost:3000/api/v1/files/photo-1/content?download=1", download: "shot.png" },
  ]);
});

it("keeps a download action in the image lightbox", async () => {
  await act(async () => root?.render(<ArtifactImage artifactId="photo-1" name="shot.png" />));
  await act(async () => container.querySelector<HTMLButtonElement>("button")?.click());
  const lightbox = document.body.querySelector<HTMLElement>('[data-slot="dialog-content"]');
  expect(lightbox?.querySelector("img")?.getAttribute("alt")).toBe("shot.png");
  const button = lightbox?.querySelector<HTMLButtonElement>(
    'button[aria-label="Download shot.png"]',
  );
  if (!button) throw new Error("lightbox download button did not render");
  await act(async () => button.click());
  expect(mocks.contentUrl).toHaveBeenCalledWith("photo-1", { download: true });
  expect(mocks.anchors).toEqual([
    { href: "http://localhost:3000/api/v1/files/photo-1/content?download=1", download: "shot.png" },
  ]);
});
