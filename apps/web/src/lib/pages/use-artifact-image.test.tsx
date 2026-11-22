// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useArtifactImage } from "./use-artifact-image";

vi.mock("../query/rpc", () => ({ selectedSpaceId: () => null }));

let container: HTMLDivElement;
let root: Root;

function Image({ artifactId, enabled = true }: { artifactId: string; enabled?: boolean }) {
  const src = useArtifactImage(artifactId, enabled);
  return src ? <img src={src} alt="" /> : null;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("streams images from the file content URL", async () => {
  await act(async () => root.render(<Image artifactId="photo" />));
  expect(container.querySelector("img")?.getAttribute("src")).toBe("/api/v1/files/photo/content");
});

it("renders nothing until its card is near the viewport", async () => {
  await act(async () => root.render(<Image artifactId="photo" enabled={false} />));
  expect(container.querySelector("img")).toBeNull();
  await act(async () => root.render(<Image artifactId="photo" />));
  expect(container.querySelector("img")?.getAttribute("src")).toBe("/api/v1/files/photo/content");
});
