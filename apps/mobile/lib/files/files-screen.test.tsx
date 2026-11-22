// @vitest-environment jsdom

import type { DriveFile, FileFolder } from "@rakazo/contracts";
import { flush } from "@rakazo/core/test-async";
import type { ReactNode } from "react";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import FilesScreen from "../../app/artifacts";
import { queryClient } from "../query/query";

// Expo modules read React Native's __DEV__, which this test environment does not define.
vi.hoisted(() => {
  Reflect.set(globalThis, "__DEV__", false);
});

type MenuAction = {
  id?: string;
  title: string;
  subactions?: MenuAction[];
};

const state = vi.hoisted(() => ({
  rpc: vi.fn(),
  params: { current: {} as Record<string, string> },
  setParams: vi.fn(),
  push: vi.fn(),
  back: vi.fn(),
  offerDriveFile: vi.fn(),
  changeListener: undefined as undefined | (() => void),
  changeKind: "",
  page: undefined as unknown,
  trashedPage: undefined as unknown,
  folderTree: [] as unknown[],
  listInputs: [] as Array<Record<string, unknown>>,
  alert: vi.fn(),
}));

vi.mock("react-native", () => {
  const component =
    (tag: string) =>
    ({ children }: { children?: ReactNode }) =>
      tag === "span" ? <span>{children}</span> : <div>{children}</div>;
  const Pressable = ({
    children,
    onPress,
    onLongPress,
    accessibilityLabel,
    disabled,
  }: {
    children?: ReactNode | ((state: { pressed: boolean }) => ReactNode);
    onPress?: () => void;
    onLongPress?: () => void;
    accessibilityLabel?: string;
    disabled?: boolean;
  }) => (
    <button
      type="button"
      aria-label={accessibilityLabel}
      disabled={disabled}
      onClick={disabled ? undefined : onPress}
      onContextMenu={onLongPress}
    >
      {typeof children === "function" ? children({ pressed: false }) : children}
    </button>
  );
  const FlatList = ({
    data = [],
    renderItem,
    ListHeaderComponent,
    ListEmptyComponent,
    ListFooterComponent,
  }: {
    data?: unknown[];
    renderItem: (info: { item: unknown; index: number }) => ReactNode;
    ListHeaderComponent?: ReactNode;
    ListEmptyComponent?: ReactNode;
    ListFooterComponent?: ReactNode;
  }) => (
    <div>
      {ListHeaderComponent}
      {data.length ? data.map((item, index) => renderItem({ item, index })) : ListEmptyComponent}
      {ListFooterComponent}
    </div>
  );
  return {
    ActivityIndicator: () => null,
    Alert: { alert: state.alert },
    FlatList,
    Platform: { OS: "ios" },
    Pressable,
    RefreshControl: () => null,
    ScrollView: component("div"),
    StyleSheet: { create: (value: unknown) => value },
    Text: component("span"),
    View: component("div"),
  };
});

vi.mock("expo-router", () => ({
  useFocusEffect: (effect: () => undefined | (() => void)) => useEffect(effect, [effect]),
  useIsFocused: () => true,
  useLocalSearchParams: () => state.params.current,
  useRouter: () => ({ back: state.back, push: state.push, setParams: state.setParams }),
}));

vi.mock("../api/api", () => ({
  captureApiRequestContext: async () => ({
    apiBase: "https://app.example.test",
    headers: { "x-rakazo-space-id": "space-1" },
    sessionGeneration: 1,
  }),
  currentApiBase: () => "https://app.example.test",
  rpc: state.rpc,
  selectedSpaceId: () => "space-1",
}));
vi.mock("../api/session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("../api/user-error", () => ({
  errorText: (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback,
}));
vi.mock("../api/roster-signals", () => ({
  useSpaceChanges: (kind: string, onChange: () => void) => {
    state.changeKind = kind;
    state.changeListener = onChange;
  },
}));
vi.mock("../platform/app-foreground", () => ({ useAppForeground: () => true }));
vi.mock("../navigation/screen-header", () => ({ useScreenHeader: () => undefined }));
vi.mock("../layout/side-insets", () => ({ useSideInsets: () => undefined }));
vi.mock("../layout/content-bottom-inset", () => ({ useContentBottomInset: () => 0 }));
vi.mock("../native/native", () => ({
  native: new Proxy({}, { get: (_, key) => String(key) }),
  useResolvedAppearance: () => "light",
  useThemedStyles: () => ({}),
}));
vi.mock("../inbox/activity", () => ({ formatActivityRelativeTime: () => "now" }));
vi.mock("../composer/pick-attachments", () => ({ pickDocuments: vi.fn() }));
vi.mock("../files/file-upload", () => ({ uploadMobileFile: vi.fn() }));
vi.mock("../files/drive-file-pick", () => ({ offerDriveFile: state.offerDriveFile }));
vi.mock("../artifacts/artifact-open", () => ({
  downloadMobileArtifact: vi.fn(),
  shareLocalFile: vi.fn(),
}));
vi.mock("../../components/bots/profile-edit-dialog", () => ({
  useTextEditDialog: () => ({ ask: vi.fn(), dialog: null }),
}));
vi.mock("../../components/native/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("../../components/native/native-action-button", () => ({
  NativeActionButton: ({
    label,
    onPress,
    disabled,
  }: {
    label: string;
    onPress: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" aria-label={label} disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../../components/ui/load-failure", () => ({
  LoadFailure: ({ message, onRetry }: { message: string; onRetry: () => void }) => (
    <button type="button" onClick={onRetry}>
      {message}
    </button>
  ),
}));
vi.mock("../../components/ui/long-press-menu", () => ({
  LongPressMenu: ({
    actions,
    onPressAction,
    children,
  }: {
    actions: MenuAction[];
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
    children: (onLongPress?: () => void) => ReactNode;
  }) => {
    const flat = (list: MenuAction[]): MenuAction[] =>
      list.flatMap((action) =>
        action.subactions ? [action, ...flat(action.subactions)] : [action],
      );
    return (
      <div>
        {children(undefined)}
        {flat(actions).map((action) => (
          <button
            type="button"
            key={action.id}
            aria-label={`menu:${action.title}`}
            onClick={() => onPressAction({ nativeEvent: { event: action.id ?? action.title } })}
          >
            {action.title}
          </button>
        ))}
      </div>
    );
  },
}));

const file: DriveFile = {
  id: "file-1",
  botId: "bot-1",
  groupId: null,
  runId: null,
  folderId: null,
  source: "upload",
  name: "report.md",
  description: null,
  mimeType: "text/markdown",
  size: 6,
  hash: "hash",
  version: 1,
  versionCount: 1,
  trashedAt: null,
  createdAt: "2026-11-22T10:00:00.000Z",
  updatedAt: "2026-11-22T10:00:00.000Z",
  contentUrl: "/api/v1/files/file-1/content",
};

const folder: FileFolder = {
  id: "folder-1",
  parentId: null,
  name: "Reports",
  trashedAt: null,
  createdAt: "2026-11-22T10:00:00.000Z",
  updatedAt: "2026-11-22T10:00:00.000Z",
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  queryClient.clear();
  state.params.current = {};
  state.setParams.mockReset();
  state.push.mockReset();
  state.back.mockReset();
  state.offerDriveFile.mockReset();
  state.changeListener = undefined;
  state.changeKind = "";
  state.page = { breadcrumbs: [], folders: [], files: [], nextCursor: null };
  state.trashedPage = { breadcrumbs: [], folders: [], files: [], nextCursor: null };
  state.folderTree = [];
  state.listInputs.length = 0;
  state.alert.mockReset();
  state.rpc.mockReset().mockImplementation(async (proc: string, input: Record<string, unknown>) => {
    if (proc === "me") return { userId: "user-1" };
    if (proc === "files/folderTree") return { folders: state.folderTree };
    if (proc === "files/list") {
      state.listInputs.push(input);
      return input.trashed ? state.trashedPage : state.page;
    }
    return { ok: true };
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render() {
  await act(async () => root.render(<FilesScreen />));
  await act(flush);
}

function button(label: string): HTMLElement {
  const match = [...container.querySelectorAll<HTMLElement>("[aria-label]")].find(
    (node) => node.getAttribute("aria-label") === label,
  );
  if (!match) throw new Error(`No button "${label}" in: ${container.textContent}`);
  return match;
}

async function press(label: string) {
  await act(async () => button(label).click());
  await act(flush);
}

it("lists a bot's files and opens a folder through the route params", async () => {
  state.params.current = { botId: "bot-1" };
  state.page = { breadcrumbs: [], folders: [folder], files: [], nextCursor: null };
  await render();

  expect(state.listInputs[0]).toMatchObject({ botId: "bot-1", folderId: null });
  expect(container.textContent).toContain("Reports");

  await press("Reports");
  expect(state.setParams).toHaveBeenCalledWith({ folderId: "folder-1" });
});

it("hands a picked file to the composer instead of previewing it", async () => {
  state.params.current = { pick: "1", threadKey: "bot-1" };
  state.page = { breadcrumbs: [], folders: [], files: [file], nextCursor: null };
  await render();

  await press("report.md");
  expect(state.offerDriveFile).toHaveBeenCalledWith("bot-1", file);
  expect(state.back).toHaveBeenCalledOnce();
  expect(state.push).not.toHaveBeenCalled();
});

it("offers Restore and permanent deletion in the Trash, calling their procedures", async () => {
  const trashed = { ...file, trashedAt: "2026-11-22T11:00:00.000Z" };
  state.trashedPage = { breadcrumbs: [], folders: [], files: [trashed], nextCursor: null };
  await render();

  await press("Trash");
  expect(state.listInputs.at(-1)).toMatchObject({ trashed: true });
  expect(container.textContent).toContain("report.md");
  expect(container.textContent).toContain("Restore");
  expect(container.textContent).toContain("Delete permanently");

  await press("menu:Restore");
  expect(state.rpc).toHaveBeenCalledWith("files/restore", { fileId: "file-1" }, expect.anything());

  await press("menu:Delete permanently");
  const confirm = state.alert.mock.lastCall!;
  const destructive = confirm[2].find((item: { style?: string }) => item.style === "destructive");
  await act(async () => destructive.onPress());
  await act(flush);
  expect(state.rpc).toHaveBeenCalledWith(
    "files/deletePermanent",
    { fileId: "file-1" },
    expect.anything(),
  );
});

it("re-reads the list when the server signals a files change", async () => {
  state.page = { breadcrumbs: [], folders: [], files: [file], nextCursor: null };
  await render();
  const before = state.listInputs.length;
  expect(state.changeKind).toBe("files");

  await act(async () => state.changeListener?.());
  await act(flush);
  expect(state.listInputs.length).toBeGreaterThan(before);
});
