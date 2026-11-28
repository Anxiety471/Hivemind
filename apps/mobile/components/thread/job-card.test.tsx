// @vitest-environment jsdom

import type { MessageBlock } from "@rakazo/contracts";
import { lightTokens } from "@rakazo/ui-tokens";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatReferencesContext } from "../../lib/board/chat-references";
import { JobCard } from "./job-card";

type JobBlock = Extract<MessageBlock, { kind: "job" }>;

const linking = vi.hoisted(() => ({
  canOpenURL: vi.fn(async () => true),
  openURL: vi.fn(async () => undefined),
}));

vi.mock("../../lib/api/api", () => ({
  currentApiBase: () => "https://app.example.test",
  selectedSpaceId: () => null,
  subscribeSpaceSelection: () => () => undefined,
}));
vi.mock("../../lib/api/session", () => ({
  currentSessionGeneration: () => 1,
  loadSessionToken: vi.fn(),
  subscribeSessionGeneration: () => () => undefined,
}));
vi.mock("../../lib/board/ticket-detail-sheet", () => ({ TicketDetailSheet: () => null }));
vi.mock("../../lib/appearance/appearance", () => ({ mobileTokens: () => lightTokens }));
vi.mock("@rakazo/chat-ui/hooks", () => ({ useNow: () => 0 }));

vi.mock("react-native", () => {
  function View({ children }: { children?: ReactNode }) {
    return createElement("div", null, children);
  }
  function Text(props: {
    children?: ReactNode;
    style?: unknown;
    accessibilityRole?: string;
    accessibilityLabel?: string;
  }) {
    return createElement(
      "span",
      { role: props.accessibilityRole, "aria-label": props.accessibilityLabel },
      props.children,
    );
  }
  function Pressable(props: {
    children?: ReactNode;
    disabled?: boolean;
    accessibilityRole?: string;
    accessibilityLabel?: string;
    testID?: string;
    onPress?: () => void;
  }) {
    return createElement(
      "button",
      {
        disabled: props.disabled,
        type: "button",
        role: props.accessibilityRole,
        "aria-label": props.accessibilityLabel,
        "data-testid": props.testID,
        onClick: () => props.onPress?.(),
      },
      props.children,
    );
  }
  return {
    Linking: linking,
    Platform: { OS: "ios", select: (options: { ios?: unknown }) => options.ios },
    Pressable,
    StyleSheet: { create: <T,>(styles: T) => styles },
    Text,
    View,
  };
});

const repository = "https://code.example.test/acme/app";
const sha = "ffc2c036f5804d114af39ea6b91c8a75b9cbe55b";

function job(overrides: Partial<JobBlock>): JobBlock {
  return {
    kind: "job",
    jobId: "job-1",
    title: "Refactor billing",
    state: "finished",
    ...overrides,
  } as JobBlock;
}

describe("job card links", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  function render(
    block: JobBlock,
    repositories?: { url: string; aliases: string[]; isDefault: boolean }[],
  ) {
    act(() => {
      root.render(
        <ChatReferencesContext.Provider
          value={{ referenceContext: repositories ? { repositories } : undefined }}
        >
          <JobCard block={block} />
        </ChatReferencesContext.Provider>,
      );
    });
  }

  function link(name: string) {
    return [...container.querySelectorAll<HTMLElement>('[role="link"]')].find(
      (element) => element.getAttribute("aria-label") === name,
    );
  }

  it("opens the pull request and commit from the job's own URLs", async () => {
    render(
      job({
        commit: sha,
        prUrl: `${repository}/pull/19`,
        prLabel: "#19",
      }),
    );

    await act(async () => link("#19")?.click());
    expect(linking.openURL).toHaveBeenLastCalledWith(`${repository}/pull/19`);

    await act(async () => link("Commit ffc2c03")?.click());
    expect(linking.openURL).toHaveBeenLastCalledWith(`${repository}/commit/${sha}`);
  });

  it("links the commit through the Space's repositories when the job names none", async () => {
    render(job({ commit: sha, repo: "acme/app" }), [
      { url: repository, aliases: [], isDefault: true },
    ]);

    await act(async () => link("Commit ffc2c03")?.click());

    expect(linking.openURL).toHaveBeenLastCalledWith(`${repository}/commit/${sha}`);
  });

  it("shows a plain commit when no repository URL is available", () => {
    render(job({ commit: sha, repo: "acme/app" }));

    expect(container.textContent).toContain("ffc2c03");
    expect(link("Commit ffc2c03")).toBeUndefined();
  });

  it("falls back to the default pull request label", () => {
    render(job({ prUrl: `${repository}/pull/7` }));

    expect(link("Pull request")).toBeDefined();
  });
});
