// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import { MODEL_REQUIRED_SEND_ERROR, resolveComposerSendPlan } from "@rakazo/core";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WebOutboxAttachment, WebSendAttempt } from "../../../lib/composer/send-outbox";
import { PendingSendBubble } from "./pending-send-bubble";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce(
        (text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`,
        "",
      ),
  }),
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  i18n.load("en", {});
  i18n.activate("en");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function planFor(text: string, hasAttachments = false) {
  return resolveComposerSendPlan({ text, mentions: [], hasAttachments });
}

function attempt(overrides: Partial<WebSendAttempt> = {}): WebSendAttempt {
  const text = overrides.payload?.trimmed ?? "hello";
  return {
    clientNonce: "nonce-1",
    createdAt: 0,
    scope: { userId: "user-1", spaceId: null },
    payload: {
      originThreadKey: "bot-1",
      displayText: text,
      replyPreview: null,
      botTarget: "bot-1",
      reroutedToGroup: false,
      plan: planFor(text),
      trimmed: text,
      attachments: [],
    },
    artifactIds: new Map(),
    state: "pending",
    retryCount: 0,
    persisted: false,
    ...overrides,
  };
}

function fileAttachment(
  id: string,
  options: { name?: string; previewUrl?: string; size?: number } = {},
): WebOutboxAttachment {
  const name = options.name ?? `${id}.png`;
  return {
    kind: "file",
    id,
    name,
    mimeType: options.previewUrl ? "image/png" : "text/plain",
    size: options.size ?? 2048,
    file: new File(["bytes"], name, { type: "application/pdf" }),
    uploadNonce: `attachment:bot-1:${id}`,
    ...(options.previewUrl ? { previewUrl: options.previewUrl } : {}),
  };
}

const noop = () => undefined;

function render(props: Partial<ComponentProps<typeof PendingSendBubble>> = {}) {
  act(() =>
    root.render(
      <PendingSendBubble
        attempt={attempt()}
        onRetry={noop}
        onSendAsFile={noop}
        onDiscard={noop}
        {...props}
      />,
    ),
  );
}

function bubble(): HTMLElement {
  const element = container.querySelector<HTMLElement>('[data-testid="pending-send-bubble"]');
  if (!element) throw new Error("pending send bubble not rendered");
  return element;
}

function button(label: string): HTMLButtonElement {
  const found = [...bubble().querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) =>
      candidate.getAttribute("aria-label") === label || candidate.textContent === label,
  );
  if (!found) throw new Error(`no button "${label}"`);
  return found;
}

it("shows the words, the reply and the files of a send still waiting", () => {
  const drive: WebOutboxAttachment = {
    kind: "drive",
    id: "drive-1",
    driveFile: {
      artifactId: "artifact-1",
      name: "notes.pdf",
      mimeType: "application/pdf",
      size: 4096,
    },
  };
  render({
    attempt: attempt({
      payload: {
        ...attempt().payload,
        displayText: "two files",
        replyPreview: "earlier words",
        attachments: [fileAttachment("pick-1", { previewUrl: "blob:preview-1" }), drive],
      },
    }),
  });

  expect(bubble().textContent).toContain("two files");
  expect(bubble().textContent).toContain("earlier words");
  expect(bubble().textContent).toContain("notes.pdf");
  expect(bubble().textContent).toContain("4 KB");
  const image = bubble().querySelector("img");
  expect(image?.getAttribute("src")).toBe("blob:preview-1");
  expect(image?.getAttribute("alt")).toBe("pick-1.png");
});

it("says it is sending while the server has the message", () => {
  render({ attempt: attempt({ state: "pending" }) });

  expect(bubble().dataset.sendState).toBe("pending");
  expect(bubble().textContent).toContain("Sending…");
  expect(bubble().querySelectorAll("button")).toHaveLength(0);
});

it("waits for the connection with a retry and a way to cancel", () => {
  const onRetry = vi.fn();
  const onDiscard = vi.fn();
  render({
    attempt: attempt({ state: "queued", error: "Failed to send message" }),
    onRetry,
    onDiscard,
  });

  expect(bubble().dataset.sendState).toBe("queued");
  expect(bubble().textContent).toContain("Waiting for connection…");
  act(() => button("Retry").click());
  expect(onRetry).toHaveBeenCalledWith("nonce-1");
  act(() => button("Cancel message").click());
  expect(onDiscard).toHaveBeenCalledWith("nonce-1");
});

it("offers a file resend when the model cannot take an image", () => {
  const onSendAsFile = vi.fn();
  const onOpenModels = vi.fn();
  const onDiscard = vi.fn();
  render({
    attempt: attempt({
      state: "failed",
      imageConfirmation: true,
      error: "Image input is not configured for this model.",
    }),
    onSendAsFile,
    onOpenModels,
    onDiscard,
  });

  expect(bubble().textContent).toContain("Image input is not configured for this model.");
  act(() => button("Send as file").click());
  expect(onSendAsFile).toHaveBeenCalledWith("nonce-1");
  act(() => button("Change model").click());
  expect(onOpenModels).toHaveBeenCalledTimes(1);
  act(() => button("Delete unsent message").click());
  expect(onDiscard).toHaveBeenCalledWith("nonce-1");
});

it("points a message without a model at the model list", () => {
  const onOpenModels = vi.fn();
  const onDiscard = vi.fn();
  render({
    attempt: attempt({ state: "failed", error: MODEL_REQUIRED_SEND_ERROR }),
    onOpenModels,
    onDiscard,
  });

  expect(bubble().textContent).toContain("Not sent");
  act(() => button("Choose a model").click());
  expect(onOpenModels).toHaveBeenCalledTimes(1);
  act(() => button("Delete unsent message").click());
  expect(onDiscard).toHaveBeenCalledWith("nonce-1");
});

it("retries a failed send and keeps its error behind the label", () => {
  const onRetry = vi.fn();
  const onDiscard = vi.fn();
  render({
    attempt: attempt({ state: "failed", error: "The server answered 500" }),
    onRetry,
    onDiscard,
  });

  expect(bubble().textContent).toContain("Not sent");
  expect(bubble().querySelector('[title="The server answered 500"]')).not.toBeNull();
  act(() => button("Retry").click());
  expect(onRetry).toHaveBeenCalledWith("nonce-1");
  act(() => button("Delete unsent message").click());
  expect(onDiscard).toHaveBeenCalledWith("nonce-1");
});

it("shows a refused send without a retry", () => {
  const onRetry = vi.fn();
  const onDiscard = vi.fn();
  render({
    attempt: attempt({ state: "refused", error: "Message is too long" }),
    onRetry,
    onDiscard,
  });

  expect(bubble().textContent).toContain("Message is too long");
  expect(() => button("Retry")).toThrow();
  act(() => button("Delete unsent message").click());
  expect(onDiscard).toHaveBeenCalledWith("nonce-1");
});

it("hides the model actions when no model picker is open to it", () => {
  render({ attempt: attempt({ state: "failed", error: MODEL_REQUIRED_SEND_ERROR }) });

  expect(bubble().textContent).toContain("Not sent");
  expect(bubble().textContent).not.toContain("Choose a model");
  expect(() => button("Delete unsent message")).not.toThrow();
});
