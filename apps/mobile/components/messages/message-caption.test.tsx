// @vitest-environment jsdom

import { lightTokens } from "@rakazo/ui-tokens";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatReferencesContext } from "../../lib/board/chat-references";
import { OpenPageContext } from "../../lib/messages/message-mentions";
import { MessageCaption } from "./message-caption";

const linking = vi.hoisted(() => ({
  canOpenURL: vi.fn(async () => true),
  openURL: vi.fn(async () => undefined),
}));

// Only drawn for a sent mention, which these tests do not use.
vi.mock("../bots/bot-avatar", () => ({ BotAvatar: () => null }));
vi.mock("../native/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("../../lib/api/api", () => ({
  captureApiRequestContext: vi.fn(),
  currentApiBase: () => "https://app.example.test",
  rpc: vi.fn(),
  selectedSpaceId: () => null,
  subscribeSpaceSelection: () => () => undefined,
}));
vi.mock("../../lib/api/session", () => ({
  currentSessionGeneration: () => 1,
  loadSessionToken: vi.fn(),
  subscribeSessionGeneration: () => () => undefined,
}));
vi.mock("../../lib/board/ticket-detail-sheet", () => ({ TicketDetailSheet: () => null }));

vi.mock("react-native", () => {
  function View({ children }: { children?: ReactNode }) {
    return createElement("div", null, children);
  }
  function Text(props: {
    children?: ReactNode;
    style?: unknown;
    accessibilityRole?: string;
    onPress?: () => void;
  }) {
    const style = Array.isArray(props.style) ? Object.assign({}, ...props.style) : props.style;
    return createElement(
      "span",
      { style, role: props.accessibilityRole, onClick: props.onPress },
      props.children,
    );
  }
  return {
    View,
    Text,
    ScrollView: View,
    Pressable: View,
    TextInput: Text,
    Image: () => createElement("img"),
    Animated: { View, createAnimatedComponent: (component: unknown) => component },
    StyleSheet: {
      create: <T,>(styles: T) => styles,
      flatten: (styles: unknown) => (Array.isArray(styles) ? Object.assign({}, ...styles) : styles),
      hairlineWidth: 1,
    },
    Platform: { OS: "ios", select: (options: { ios?: unknown }) => options.ios },
    Linking: linking,
    Alert: {
      alert: (
        _title: string,
        _message: string,
        buttons: Array<{ text: string; onPress?: () => void }>,
      ) => buttons.find((button) => button.text === "Open")?.onPress?.(),
    },
    I18nManager: { isRTL: false },
    useColorScheme: () => "light",
  };
});

describe("attachment captions", () => {
  let root: Root;
  let container: HTMLDivElement;
  const caption = "**important** https://example.test/docs";

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

  function render(role: "bot" | "user", streaming = false) {
    act(() => {
      root.render(
        <MessageCaption
          role={role}
          text={caption}
          tokens={lightTokens}
          colorScheme="light"
          streaming={streaming}
        />,
      );
    });
  }

  it("formats bot Markdown through ChatMarkdown", () => {
    render("bot");

    // A bare address shows as host and path, joined to its site icon and isolated.
    expect(container.textContent).toBe("important \u2060\u2068example.test/docs\u2069");
    expect(container.querySelector('[style*="font-weight: 600"]')?.textContent).toBe("important");
    expect(container.textContent).not.toContain("**");
  });

  it("keeps user Markdown literal through LinkifiedText and links explicit URLs", async () => {
    render("user");

    expect(container.textContent).toBe("**important** \u2060\u2068example.test/docs\u2069");
    expect(container.querySelector('[style*="font-weight: 600"]')).toBeNull();
    const link = container.querySelector<HTMLElement>('[role="link"]');
    expect(link?.textContent).toBe("\u2060\u2068example.test/docs\u2069");

    await act(async () => link?.click());

    expect(linking.openURL).toHaveBeenCalledWith("https://example.test/docs");
  });

  it("opens the page a sent page link names from the user's bubble", async () => {
    const openPage = vi.fn();
    const role = "user";
    act(() => {
      root.render(
        <OpenPageContext.Provider value={openPage}>
          <MessageCaption
            role={role}
            text={"[Plan](page:pg_1)\nnice"}
            tokens={lightTokens}
            colorScheme="light"
            streaming={false}
          />
        </OpenPageContext.Provider>,
      );
    });

    expect(container.textContent).not.toContain("page:pg_1");
    const chip = container.querySelector<HTMLElement>('[role="link"]');
    expect(chip?.textContent).toContain("Plan");

    await act(async () => chip?.click());

    expect(openPage).toHaveBeenCalledWith("pg_1");
  });

  describe("board references", () => {
    const repositories = [
      { url: "https://code.example.test/acme/app", aliases: [], isDefault: true },
    ];
    const tickets = [
      {
        ref: "TASK-397",
        repository: "https://code.example.test/acme/app",
        pullRequests: [{ url: "https://code.example.test/acme/app/pull/19" }],
      },
    ];

    function renderWithReferences(role: "bot" | "user", text: string, openTicket = vi.fn()) {
      act(() => {
        root.render(
          <ChatReferencesContext.Provider
            value={{
              referenceContext: { ticketPrefix: "TASK", repositories, tickets },
              openTicket,
            }}
          >
            <MessageCaption
              role={role}
              text={text}
              tokens={lightTokens}
              colorScheme="light"
              streaming={false}
            />
          </ChatReferencesContext.Provider>,
        );
      });
      return openTicket;
    }

    it("opens a ticket chip from the user's bubble", async () => {
      const openTicket = renderWithReferences("user", "Please check TASK-397");

      const chip = [...container.querySelectorAll<HTMLElement>('[role="link"]')].find(
        (element) => element.textContent === "TASK-397",
      );
      expect(chip).toBeDefined();

      await act(async () => chip?.click());

      expect(openTicket).toHaveBeenCalledWith("TASK-397");
    });

    it("links tickets, pull requests and commit SHAs in bot Markdown", async () => {
      const openTicket = renderWithReferences("bot", "Fixed TASK-397 in PR #19 at `ffc2c036`");

      const linkTexts = [...container.querySelectorAll<HTMLElement>('[role="link"]')].map(
        (element) => element.textContent?.replace(/[\u2060\u2068\u2069]/g, ""),
      );
      expect(linkTexts).toEqual(expect.arrayContaining(["TASK-397", "PR #19", "ffc2c036"]));

      const chip = [...container.querySelectorAll<HTMLElement>('[role="link"]')].find(
        (element) => element.textContent === "TASK-397",
      );
      await act(async () => chip?.click());

      expect(openTicket).toHaveBeenCalledWith("TASK-397");
    });

    it("leaves references plain without board context", () => {
      const botMessage = { role: "bot" as const };
      act(() => {
        root.render(
          <MessageCaption
            {...botMessage}
            text="Fixed TASK-397 in PR #19"
            tokens={lightTokens}
            colorScheme="light"
            streaming={false}
          />,
        );
      });

      expect(container.querySelector('[role="link"]')).toBeNull();
      expect(container.textContent).toContain("TASK-397");
    });
  });
});
