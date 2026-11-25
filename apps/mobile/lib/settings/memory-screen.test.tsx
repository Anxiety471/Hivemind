// @vitest-environment jsdom
import type { MemoryRoamerSettings } from "@rakazo/contracts";
import { deferred, flush } from "@rakazo/core/test-async";
import type { ReactNode } from "react";
import { act, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import MemoryScreen from "../../app/(settings)/memory";
import { queryClient } from "../query/query";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  rpc: vi.fn(),
  t: (text: string) => text,
}));
vi.mock("../layout/side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("../appearance/appearance", () => ({ mobileTokens: () => ({ destructive: "#f00" }) }));
vi.mock("../native/native", () => ({
  native: {},
  useThemedStyles: (create: () => unknown) => create(),
}));
vi.mock("../api/api", () => ({
  currentApiBase: () => "https://app.example.test",
  selectedSpaceId: () => "space-fixture",
  captureApiRequestContext: async () => ({ apiBase: "https://app.example.test", headers: {} }),
  rpc: (method: string, input: unknown) => mocks.rpc(method, input),
}));
vi.mock("../api/session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("expo-router", () => ({
  useRouter: () => ({ push: mocks.push }),
  useFocusEffect: (effect: () => (() => void) | undefined) => useEffect(effect, [effect]),
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../components/settings/settings-group", () => ({
  SettingsGroup: ({
    label,
    children,
    footer,
  }: {
    label?: string;
    children?: ReactNode;
    footer?: string;
  }) => (
    <div>
      {label}
      {children}
      {footer}
    </div>
  ),
  SettingsRow: ({
    title,
    detail,
    onPress,
  }: {
    title: string;
    detail?: string;
    onPress?: () => void;
  }) => (
    <button type="button" aria-label={title} onClick={onPress}>
      {title}
      {detail}
    </button>
  ),
  SettingsSwitch: ({
    label,
    value,
    onChange,
  }: {
    label: string;
    value: boolean;
    onChange: (value: boolean) => void;
  }) => (
    <button type="button" aria-label={label} aria-pressed={value} onClick={() => onChange(!value)}>
      {label}
    </button>
  ),
  SettingsFooter: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
}));
vi.mock("../../components/native/native-action-button", () => ({
  NativeActionButton: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button type="button" onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("react-native", () => {
  const View = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    View,
    ScrollView: ({
      children,
      refreshControl,
    }: {
      children?: ReactNode;
      refreshControl?: ReactNode;
    }) => (
      <div>
        {refreshControl}
        {children}
      </div>
    ),
    RefreshControl: ({ onRefresh }: { onRefresh: () => void }) => (
      <button type="button" aria-label="Refresh" onClick={onRefresh} />
    ),
    Text: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
    TextInput: () => <input />,
    ActivityIndicator: () => <span role="status" />,
    StyleSheet: { create: (styles: unknown) => styles },
  };
});

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  queryClient.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function settle() {
  await act(flush);
}
async function render() {
  await act(async () => root.render(<MemoryScreen />));
  await settle();
}

const roamerSettings: MemoryRoamerSettings = {
  enabled: false,
  intervalMinutes: 360,
  lastRunAt: null,
  lastError: null,
  lastChanges: 0,
  lastModel: null,
  lastFailures: [],
  lastReport: [],
  retryAt: null,
  retryAttempt: 0,
};

function mockRpc(list: () => Promise<unknown>, roamer = roamerSettings) {
  mocks.rpc.mockImplementation((method: string) =>
    method === "memory/roamer" ? Promise.resolve(roamer) : list(),
  );
}

it("lists the space's shared notes and opens one in the editor", async () => {
  mockRpc(() =>
    Promise.resolve([
      { id: "index-1", scope: "user", botId: null, path: "MEMORY.md", content: "", revision: 1 },
      { id: "team-1", scope: "user", botId: null, path: "team.md", content: "x", revision: 2 },
    ]),
  );
  await render();
  expect(mocks.rpc).toHaveBeenCalledWith("memory/list", { scope: "user" });
  expect(container.textContent).toContain("MEMORY.md");
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="team.md"]')?.click(),
  );
  expect(mocks.push).toHaveBeenCalledWith({ pathname: "/memory-note", params: { id: "team-1" } });
});

it("shows every bot's outcome and changes", async () => {
  mockRpc(() => Promise.resolve([]), {
    ...roamerSettings,
    enabled: true,
    lastRunAt: "2026-11-22T23:30:32.920Z",
    lastChanges: 1,
    lastReport: [
      {
        kind: "bot",
        id: "bot-1",
        name: "Crumb",
        status: "ok",
        model: "deepseek-v4.1-flash",
        changes: [
          {
            scope: "bot",
            path: "MEMORY.md",
            action: "update",
            beforeBytes: 100,
            afterBytes: 90,
          },
        ],
        checkedAt: "2026-11-22T23:30:32.920Z",
      },
      {
        kind: "bot",
        id: "bot-2",
        name: "Hatcha",
        status: "ok",
        changes: [],
        checkedAt: "2026-11-22T23:30:33.920Z",
      },
    ],
  });
  await render();
  expect(container.textContent).toContain("Completed");
  expect(container.textContent).toContain("Crumb");
  expect(container.textContent).toContain("MEMORY.md");
  expect(container.textContent).toContain("Hatcha");
  expect(container.textContent).toContain("No changes");
});

it("shows which targets failed and when the next retry runs", async () => {
  mockRpc(() => Promise.resolve([]), {
    ...roamerSettings,
    enabled: true,
    lastRunAt: "2026-11-22T23:30:32.920Z",
    lastError: "1 bot failed",
    lastFailures: [{ kind: "bot" as const, id: "bot-1", name: "Crumb", error: "model HTTP 429" }],
    retryAt: "2026-11-22T23:45:32.920Z",
    retryAttempt: 1,
  });
  await render();
  expect(container.textContent).toContain("Last run failed");
  expect(container.textContent).toContain("Last run failures");
  expect(container.textContent).toContain("Crumb");
  expect(container.textContent).toContain("attempt 1");
});

it("says when nothing is remembered, and retries a failed load", async () => {
  let calls = 0;
  mockRpc(() => (calls++ === 0 ? Promise.reject(new Error("offline")) : Promise.resolve([])));
  await render();
  expect(container.textContent).toContain("offline");
  const retry = [...container.querySelectorAll("button")].find((b) => b.textContent === "Retry");
  await act(async () => retry?.click());
  await settle();
  expect(container.textContent).toContain("Nothing remembered yet");
  expect(container.textContent).not.toContain("offline");
});

it("keeps the newest list when an earlier load finishes last", async () => {
  const finishFirst = deferred<unknown[]>();
  let calls = 0;
  mockRpc(() => {
    const call = calls++;
    if (call === 0) return Promise.resolve([{ id: "old", path: "deleted.md" }]);
    if (call === 1) return finishFirst.promise;
    return Promise.resolve([]);
  });
  await render();
  const refresh = () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Refresh"]')?.click();
  await act(async () => refresh());
  await act(async () => refresh());
  await settle();
  expect(container.textContent).toContain("Nothing remembered yet");
  await act(async () => finishFirst.resolve([{ id: "old", path: "deleted.md" }]));
  await settle();
  expect(container.textContent).not.toContain("deleted.md");
});

it("hides cold archive documents from space shared memory", async () => {
  mockRpc(() =>
    Promise.resolve([
      {
        id: "index-1",
        scope: "user",
        botId: null,
        path: "MEMORY.md",
        content: "# Shared\n",
        revision: 1,
      },
      {
        id: "arch-1",
        scope: "user",
        botId: null,
        path: "archive/2026-11.md",
        content: "- old",
        revision: 1,
      },
    ]),
  );
  await render();
  expect(container.textContent).toContain("MEMORY.md");
  expect(container.textContent).not.toContain("archive/2026-11.md");
});
