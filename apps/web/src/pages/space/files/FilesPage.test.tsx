// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { act, cloneElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";

const files = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  folderTree: vi.fn(),
  createFolder: vi.fn(),
  renameFolder: vi.fn(),
  moveFolder: vi.fn(),
  trashFolder: vi.fn(),
  restoreFolder: vi.fn(),
  deleteFolder: vi.fn(),
  rename: vi.fn(),
  update: vi.fn(),
  move: vi.fn(),
  trash: vi.fn(),
  restore: vi.fn(),
  deletePermanent: vi.fn(),
  emptyTrash: vi.fn(),
}));
const rpcClient = vi.hoisted(() => ({ files, bootstrap: vi.fn() }));
vi.mock("../../../lib/query/rpc", () => ({
  rpc: rpcClient,
  rpcForSpace: () => rpcClient,
  createSpaceRpc: () => rpcClient,
  selectedSpaceId: () => "space-1",
}));
vi.mock("../../../components/ConfirmDialog", () => ({ ConfirmDialog: () => null }));
vi.mock("../../../components/IconTooltip", () => ({
  IconTooltip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../../components/ErrorNotice", () => ({
  ErrorNotice: ({ error }: { error: { message: string } }) => <p>{error.message}</p>,
}));
vi.mock("../../../components/messages/SandboxedHtmlViewer", () => ({
  SandboxedHtmlViewer: () => <iframe title="HTML" />,
}));
vi.mock("@rakazo/chat-ui/web", () => ({
  ChatMarkdown: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => text + part + (values[index] ?? ""), "");
  return {
    useLingui: () => ({ t, i18n: { locale: "en" } }),
    Trans: ({ children }: { children: ReactNode }) => children,
  };
});
vi.mock("@rakazo/ui-web", () => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Button: ({
      size: _size,
      variant: _variant,
      ...props
    }: ComponentProps<"button"> & { size?: string; variant?: string }) => <button {...props} />,
    buttonVariants: () => "",
    Dialog: ({ open, children }: { open?: boolean; children?: ReactNode }) =>
      open ? <div role="dialog">{children}</div> : null,
    DialogContent: Container,
    DialogFooter: Container,
    DialogHeader: Container,
    DialogTitle: Container,
    DropdownMenu: Container,
    DropdownMenuContent: Container,
    DropdownMenuItem: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
      <button type="button" onClick={onClick}>
        {children}
      </button>
    ),
    DropdownMenuSeparator: () => null,
    DropdownMenuTrigger: ({ render, children }: { render: ReactNode; children?: ReactNode }) =>
      cloneElement(render as ReactElement, {}, children),
    Empty: Container,
    EmptyDescription: Container,
    EmptyHeader: Container,
    EmptyMedia: Container,
    EmptyTitle: Container,
    Field: Container,
    FieldGroup: Container,
    FieldLabel: ({ children, htmlFor }: ComponentProps<"label">) => (
      <label htmlFor={htmlFor}>{children}</label>
    ),
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    ListSearchInput: ({
      query,
      setQuery,
      label,
    }: {
      query: string;
      setQuery: (query: string) => void;
      label: string;
    }) => (
      <input aria-label={label} value={query} onChange={(event) => setQuery(event.target.value)} />
    ),
    OptionSelect: ({
      options,
      value,
      onValueChange,
      "aria-label": label,
    }: {
      options: { value: string; label: string }[];
      value: string;
      onValueChange: (value: string) => void;
      "aria-label": string;
    }) => (
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    ),
    Spinner: (props: ComponentProps<"svg">) => <svg role="status" {...props} />,
  };
});

import { FilesPage } from "./FilesPage";

const now = new Date().toISOString();
const folder = {
  id: "folder-1",
  parentId: null,
  botId: null,
  name: "Reports",
  trashedAt: null,
  createdAt: now,
  updatedAt: now,
};
const file = {
  id: "file-1",
  botId: null,
  groupId: null,
  runId: null,
  folderId: null,
  source: "upload",
  name: "notes.txt",
  slug: null,
  description: null,
  mimeType: "text/plain",
  size: 128,
  hash: "hash",
  version: 1,
  versionCount: 1,
  trashedAt: null,
  createdAt: now,
  updatedAt: now,
  contentUrl: "/api/v1/files/file-1/content",
};
const page = { breadcrumbs: [], folders: [], files: [], nextCursor: null };

let queryClient: QueryClient;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  for (const method of Object.values(files)) method.mockReset();
  files.list.mockResolvedValue({ ...page, folders: [folder], files: [file] });
  files.get.mockResolvedValue(file);
  files.folderTree.mockResolvedValue({ folders: [] });
  files.createFolder.mockResolvedValue(folder);
});

async function renderFiles(entry = "/app/files", props: ComponentProps<typeof FilesPage> = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[entry]}>
          <Routes>
            <Route path="/app/files" element={<FilesPage {...props} />} />
            <Route path="/app/files/trash" element={<FilesPage {...props} />} />
            <Route path="/app/files/folder/:folderId" element={<FilesPage {...props} />} />
            <Route path="/app/files/:artifactId" element={<FilesPage {...props} />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
  // Every screen here asserts painted rows, so wait for the list calls the page made to answer
  // and for their result to commit. Waiting on the cache alone races the mount effect: it can
  // read a settled cache before the request even starts, then assert against a loading skeleton.
  await act(async () => {
    await vi.waitFor(() => expect(files.list).toHaveBeenCalled());
    await Promise.all(files.list.mock.results.map((result) => result.value));
    await vi.waitFor(() => expect(queryClient.isFetching()).toBe(0));
  });
  return {
    container,
    root,
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

it("lists folders and files, linking each into the Drive", async () => {
  const view = await renderFiles();
  try {
    // The listing query resolving and React committing the rows are separate steps.
    await vi.waitFor(() => expect(view.container.textContent).toContain("Reports"));
    expect(view.container.textContent).toContain("notes.txt");
    expect(view.container.querySelector("a[href='/app/files/folder/folder-1']")).not.toBeNull();
    expect(view.container.querySelector("a[href='/app/files/file-1']")).not.toBeNull();
  } finally {
    await view.cleanup();
  }
});

it("searches the whole Drive and narrows by type", async () => {
  files.list.mockImplementation(async (input: { query?: string; category?: string }) => ({
    ...page,
    files: input.query === "budget" ? [{ ...file, id: "file-2", name: "budget.csv" }] : [file],
  }));
  const view = await renderFiles();
  try {
    const search = view.container.querySelector<HTMLInputElement>(
      "input[aria-label='Search files']",
    )!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      setter?.call(search, "budget");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      await vi.waitFor(() => expect(view.container.textContent).toContain("budget.csv"));
    });
    expect(files.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ allFolders: true, query: "budget" }),
      expect.anything(),
    );
    const type = view.container.querySelector<HTMLSelectElement>(
      "select[aria-label='Filter by type']",
    )!;
    await act(async () => {
      type.value = "document";
      type.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(files.list).toHaveBeenLastCalledWith(
          expect.objectContaining({ category: "document" }),
          expect.anything(),
        ),
      );
    });
  } finally {
    await view.cleanup();
  }
});

it("toggles Trash and asks for trashed items", async () => {
  const view = await renderFiles();
  try {
    files.list.mockResolvedValue(page);
    await act(async () =>
      view.container.querySelector<HTMLButtonElement>("button[aria-label='Trash']")?.click(),
    );
    await act(async () => {
      await vi.waitFor(() => expect(view.container.textContent).toContain("Trash is empty"));
    });
    expect(files.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ trashed: true, allFolders: true }),
      expect.anything(),
    );
  } finally {
    await view.cleanup();
  }
});

it("previews a text file from its content URL", async () => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    arrayBuffer: async () => new TextEncoder().encode("hello drive").buffer,
  });
  vi.stubGlobal("fetch", fetchMock);
  const view = await renderFiles("/app/files/file-1");
  try {
    await act(async () => {
      await vi.waitFor(() =>
        expect(view.container.querySelector("pre")?.textContent).toBe("hello drive"),
      );
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/files/file-1/content?spaceId=space-1",
      expect.objectContaining({
        credentials: "include",
        headers: { Range: `bytes=0-${1024 * 1024 - 1}` },
      }),
    );
  } finally {
    await view.cleanup();
    vi.unstubAllGlobals();
  }
});

it("creates a folder in the current view", async () => {
  const view = await renderFiles();
  try {
    await act(async () =>
      view.container.querySelector<HTMLButtonElement>("button[aria-label='New folder']")?.click(),
    );
    const input = view.container.querySelector<HTMLInputElement>("input#drive-name")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      setter?.call(input, "Ideas");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const create = [...view.container.querySelectorAll("button")].find(
      (button) => button.textContent === "Create",
    )!;
    await act(async () => create.click());
    expect(files.createFolder).toHaveBeenCalledWith({ parentId: null, name: "Ideas" });
  } finally {
    await view.cleanup();
  }
});

it("shows file description and slug and updates them via Edit details", async () => {
  const richFile = {
    ...file,
    name: "Q4 Notes.txt",
    slug: "q4-notes",
    description: "Quarterly launch notes",
  };
  files.list.mockResolvedValue({ ...page, folders: [], files: [richFile] });
  files.update.mockResolvedValue({
    ...richFile,
    name: "Q4 Final Notes.txt",
    slug: "q4-final-notes",
    description: "Final launch notes",
  });
  const view = await renderFiles();
  try {
    await vi.waitFor(() => expect(view.container.textContent).toContain("Quarterly launch notes"));
    expect(view.container.textContent).toContain("q4-notes");

    const editButton = [...view.container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Edit details"),
    )!;
    await act(async () => editButton.click());

    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    const nameInput = view.container.querySelector<HTMLInputElement>("input#drive-edit-name")!;
    const slugInput = view.container.querySelector<HTMLInputElement>("input#drive-edit-slug")!;
    const descInput = view.container.querySelector<HTMLInputElement>(
      "input#drive-edit-description",
    )!;
    await act(async () => {
      setter?.call(nameInput, "Q4 Final Notes.txt");
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
      setter?.call(slugInput, "q4-final-notes");
      slugInput.dispatchEvent(new Event("input", { bubbles: true }));
      setter?.call(descInput, "Final launch notes");
      descInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const saveButton = [...view.container.querySelectorAll("button")].find(
      (button) => button.textContent === "Save",
    )!;
    await act(async () => saveButton.click());
    await act(async () => {
      await vi.waitFor(() =>
        expect(files.update).toHaveBeenCalledWith({
          fileId: "file-1",
          name: "Q4 Final Notes.txt",
          slug: "q4-final-notes",
          description: "Final launch notes",
        }),
      );
    });
  } finally {
    await view.cleanup();
  }
});

it("in the Drive app swaps the Back link and Trash toggle for a layout switch that is remembered", async () => {
  const view = await renderFiles("/app/files", { drive: true });
  try {
    expect(view.container.querySelector("a[aria-label='Back']")).toBeNull();
    expect(view.container.querySelector("button[aria-label='Trash']")).toBeNull();
    expect(view.container.querySelectorAll("li")).toHaveLength(0);
    await act(async () =>
      view.container.querySelector<HTMLButtonElement>("button[aria-label='Grid view']")?.click(),
    );
    expect(view.container.querySelectorAll("li")).toHaveLength(2);
    expect(localStorage.getItem("rakazo.driveView")).toBe("grid");
  } finally {
    localStorage.removeItem("rakazo.driveView");
    await view.cleanup();
  }
});

it("in the Drive app the Trash route lists trashed items", async () => {
  files.list.mockResolvedValue(page);
  const view = await renderFiles("/app/files/trash", { drive: true, trashView: true });
  try {
    expect(files.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ trashed: true, allFolders: true }),
      expect.anything(),
    );
  } finally {
    await view.cleanup();
  }
});
