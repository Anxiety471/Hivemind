// @vitest-environment jsdom
import { deferred } from "@rakazo/core/test-async";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  download: vi.fn(),
  writeText: vi.fn(),
}));
vi.mock("../../lib/files/file-client", () => ({
  fileContentUrl: (artifactId: string, options?: { download?: boolean }) =>
    `/api/v1/files/${artifactId}/content${options?.download ? "?download=1" : ""}`,
}));
vi.mock("../../lib/pages/artifact-open", () => ({
  fetchArtifactBytes: mocks.fetch,
  downloadArtifact: mocks.download,
  TEXT_PREVIEW_MAX_BYTES: 1024 * 1024,
}));
vi.mock("@lingui/react/macro", () => {
  const t = (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((text, part, index) => text + part + (values[index] ?? ""), "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    `«${strings.reduce((text, part, index) => text + part + (values[index] ?? ""), "")}»`,
}));
vi.mock("@rakazo/chat-ui/web", () => ({
  ChatMarkdown: ({ children }: { children: ReactNode }) => <p>{children}</p>,
}));
vi.mock("./SandboxedHtmlViewer", () => ({ SandboxedHtmlViewer: () => <iframe title="HTML" /> }));

import { ArtifactFileCard } from "./ArtifactFileCard";

let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: mocks.writeText },
  });
  mocks.writeText.mockReset().mockResolvedValue(undefined);
  mocks.fetch.mockReset().mockResolvedValue(new Uint8Array([1, 2, 3]));
  mocks.download.mockReset();
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

it.each(["audio/mpeg", "audio/wav", "audio/ogg", "audio/mp4"])(
  "streams %s controls and keeps download",
  async (mimeType) => {
    await act(async () =>
      root?.render(
        <ArtifactFileCard artifactId="audio-1" name="clip" mimeType={mimeType} size={3} />,
      ),
    );
    expect(container.querySelector("audio")).toBeNull();
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Play clip"]')?.click(),
    );
    const audio = container.querySelector("audio");
    expect(audio?.hasAttribute("controls")).toBe(true);
    expect(audio?.getAttribute("preload")).toBe("metadata");
    expect(audio?.getAttribute("aria-label")).toBe("clip");
    expect(audio?.getAttribute("src")).toBe("/api/v1/files/audio-1/content");
    expect(mocks.fetch).not.toHaveBeenCalled();
    const download = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Download clip"]',
    );
    await act(async () => download?.click());
    expect(mocks.download).toHaveBeenCalledWith("audio-1", "clip");
  },
);

it("downloads a file type it cannot preview", async () => {
  await act(async () =>
    root?.render(
      <ArtifactFileCard
        artifactId="archive-1"
        name="bundle.tar"
        mimeType="application/x-tar"
        size={3}
      />,
    ),
  );
  await act(async () => container.querySelector<HTMLButtonElement>("button")?.click());
  expect(mocks.download).toHaveBeenCalledWith("archive-1", "bundle.tar");
});

it("streams video and PDF previews instead of loading their bytes", async () => {
  await act(async () =>
    root?.render(
      <ArtifactFileCard artifactId="video-1" name="clip.mp4" mimeType="video/mp4" size={3} />,
    ),
  );
  await act(async () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="Preview clip.mp4"]')?.click(),
  );
  const video = document.body.querySelector("video");
  expect(video?.getAttribute("src")).toBe("/api/v1/files/video-1/content");
  expect(video?.getAttribute("preload")).toBe("metadata");
  expect(mocks.fetch).not.toHaveBeenCalled();
  const download = document.body.querySelector<HTMLButtonElement>(
    '[data-slot="dialog-content"] button[aria-label="Download clip.mp4"]',
  );
  await act(async () => download?.click());
  expect(mocks.download).toHaveBeenCalledExactlyOnceWith("video-1", "clip.mp4");
});

it("reads a bounded text preview from the content URL", async () => {
  const loading = deferred<Uint8Array>();
  mocks.fetch.mockReturnValue(loading.promise);
  await act(async () =>
    root?.render(
      <ArtifactFileCard
        artifactId="notes-1"
        name="notes.sh"
        mimeType="application/x-sh"
        size={30}
      />,
    ),
  );
  await act(async () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="Preview notes.sh"]')?.click(),
  );
  expect(mocks.fetch).toHaveBeenCalledWith("notes-1", {
    maxBytes: 1024 * 1024,
    signal: expect.any(AbortSignal),
  });
  await act(async () => loading.resolve(new TextEncoder().encode("#!/bin/sh\necho hi")));
  expect(document.body.querySelector("pre")?.textContent).toContain("#!/bin/sh");
});

it("copies markdown source and scopes select-all to the file body", async () => {
  mocks.fetch.mockResolvedValue(new TextEncoder().encode("# Notes\n\n**Raw** source"));
  await act(async () =>
    root?.render(
      <ArtifactFileCard artifactId="notes-1" name="notes.md" mimeType="text/markdown" size={30} />,
    ),
  );
  await act(async () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="Preview notes.md"]')?.click(),
  );
  const copy = document.body.querySelector<HTMLButtonElement>('button[aria-label="Copy notes.md"]');
  await act(async () => copy?.click());
  expect(mocks.writeText).toHaveBeenCalledExactlyOnceWith("# Notes\n\n**Raw** source");
});

it("translates every size unit and rolls up", async () => {
  await act(async () =>
    root?.render(
      [512, 1024, 1048575, 1610612736, 1.5 * 1024 ** 4].map((size) => (
        <ArtifactFileCard
          key={size}
          artifactId={`a${size}`}
          name={`f${size}.zip`}
          mimeType="application/zip"
          size={size}
        />
      )),
    ),
  );
  const sizes = [...container.querySelectorAll("button div:last-child span:last-child")].map(
    (el) => el.textContent,
  );
  expect(sizes).toEqual(["«512 B»", "«1 KB»", "«1 MB»", "«1.5 GB»", "«1.5 TB»"]);
});
