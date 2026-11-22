// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  share: vi.fn(),
  preview: vi.fn(),
}));

vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
  Text: ({ children }: { children?: ReactNode }) => createElement("span", null, children),
  ActivityIndicator: () => null,
  Alert: { alert: vi.fn() },
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
}));
vi.mock("react-native-reanimated", () => ({
  default: {
    View: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
  },
  interpolateColor: () => "transparent",
  useAnimatedStyle: () => ({}),
  useSharedValue: (value: unknown) => ({ value }),
  withSpring: (value: unknown) => value,
  withTiming: (value: unknown) => value,
}));
vi.mock("react-native-gesture-handler", () => {
  const chain = {
    onStart: () => chain,
    onUpdate: () => chain,
    onEnd: () => chain,
    onFinalize: () => chain,
    onTouchesDown: () => chain,
    onTouchesMove: () => chain,
    manualActivation: () => chain,
    maxPointers: () => chain,
    numberOfTaps: () => chain,
  };
  return {
    Gesture: { Pan: () => chain, Pinch: () => chain, Tap: () => chain },
    GestureDetector: ({ children }: { children?: ReactNode }) => children,
  };
});
vi.mock("react-native-worklets", () => ({
  scheduleOnRN: (work: () => void) => work(),
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("../../lib/appearance/appearance", () => ({
  mobileTokens: () => ({
    background: "black",
    border: "gray",
    card: "card",
    destructive: "red",
    foreground: "white",
    muted: "muted",
    mutedForeground: "gray",
    secondary: "secondary",
  }),
}));
vi.mock("../../lib/artifacts/artifact-open", () => ({
  imageArtifactPreview: mocks.preview,
  imageArtifactUri: async () => "file:///image.png",
  shareLocalFile: mocks.share,
}));
vi.mock("../../lib/native/native-controls", () => ({ iosAtLeast: () => false }));
vi.mock("../native/glass-icon-button", () => ({
  GlassIconButton: ({
    accessibilityLabel,
    onPress,
  }: {
    accessibilityLabel: string;
    onPress: () => void;
  }) =>
    createElement("button", { type: "button", "aria-label": accessibilityLabel, onClick: onPress }),
}));

import { ImageArtifactViewer } from "./image-artifact-viewer";

it("shares the viewed image through the native sheet", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.share.mockResolvedValue(undefined);
  mocks.preview.mockResolvedValue({ uri: "file:///image.png", size: { width: 100, height: 80 } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <ImageArtifactViewer
          threadTarget={{ botId: "bot-1" }}
          target={{ artifactId: "image-1", name: "photo.png", mimeType: "image/png" }}
          onClose={() => undefined}
        />,
      ),
    );
    const share = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Share photo.png"]',
    );
    expect(share).not.toBeNull();
    await act(async () => share?.click());
    expect(mocks.share).toHaveBeenCalledExactlyOnceWith(
      "file:///image.png",
      "image/png",
      "photo.png",
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
