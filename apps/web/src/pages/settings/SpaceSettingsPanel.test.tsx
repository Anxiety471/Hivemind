// @vitest-environment jsdom

import type { Board } from "@rakazo/contracts";
import { ticketLinkLabel } from "@rakazo/contracts";
import type { Deferred } from "@rakazo/core/test-async";
import { deferred } from "@rakazo/core/test-async";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryRoot as createRoot } from "../../lib/query/query-root.test-support";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return {
    useLingui: () => ({ t }),
    Trans: ({ children }: { children: ReactNode }) => children,
    Plural: ({ value, one, other }: { value: number; one: string; other: string }) =>
      (value === 1 ? one : other).replace("#", String(value)),
  };
});
vi.mock("@rakazo/ui-web", () => {
  const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Button: (props: ComponentProps<"button">) => <button type="button" {...props} />,
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    Field: Box,
    FieldLabel: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    Dialog: Box,
    DialogContent: Box,
    DialogDescription: Box,
    DialogFooter: Box,
    DialogHeader: Box,
    DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
    AlertDialog: Box,
    AlertDialogAction: (props: ComponentProps<"button">) => <button type="button" {...props} />,
    AlertDialogCancel: (props: ComponentProps<"button">) => <button type="button" {...props} />,
    AlertDialogContent: Box,
    AlertDialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
    AlertDialogFooter: Box,
    AlertDialogHeader: Box,
    AlertDialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
    RadioGroup: Box,
    RadioGroupItem: Box,
  };
});

vi.mock("./SpaceSettingOverrides", () => ({
  SpaceSettingOverrides: () => <div data-testid="space-setting-overrides" />,
}));
vi.mock("../../components/spaces/SpaceMembersSettings", () => ({
  SpaceMembersSettings: () => <div data-testid="space-members-settings" />,
}));

const client = vi.hoisted(() => ({
  spaces: {},
  boards: { get: vi.fn(), list: vi.fn(), rename: vi.fn() },
}));
vi.mock("../../lib/query/rpc", () => ({
  rpc: client,
  rpcForSpace: () => client,
  createSpaceRpc: () => client,
  selectedSpaceId: () => null,
}));

import { setLabs } from "../../lib/bootstrap";
import { SpaceSettingsPanel } from "./SpaceSettingsPanel";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

type Props = ComponentProps<typeof SpaceSettingsPanel>;

async function render(props: Partial<Props>) {
  await act(async () => {
    root.render(
      <SpaceSettingsPanel
        space={{ id: "space-a", name: "Support", canRename: true, canDelete: true, botCount: 0 }}
        onRename={async () => undefined}
        onDelete={async () => undefined}
        onLeft={() => undefined}
        onClose={() => undefined}
        {...props}
      />,
    );
  });
}

function button(label: string) {
  return [...container.querySelectorAll("button")].find(
    (item) => item.textContent === label || item.getAttribute("aria-label") === label,
  );
}

async function click(label: string) {
  const target = button(label);
  if (!target) throw new Error(`Missing ${label}`);
  await act(async () => {
    target.click();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function type(value: string) {
  const input = container.querySelector("input");
  if (!input) throw new Error("Missing name field");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function commit(key?: string) {
  const input = container.querySelector("input");
  if (!input) throw new Error("Missing name field");
  if (key) {
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    });
  }
  await act(async () => {
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("SpaceSettingsPanel", () => {
  it("renames the space when its name field is left", async () => {
    const onRename = vi.fn(async () => undefined);
    await render({ onRename });
    expect(container.querySelector("input")?.value).toBe("Support");
    await type("  Help desk  ");
    await commit();
    expect(onRename).toHaveBeenCalledWith("Help desk", client);
    expect(container.querySelector("input")?.value).toBe("Help desk");
  });

  it("keeps the name without a request when the field is cleared, unchanged, or escaped", async () => {
    const onRename = vi.fn(async () => undefined);
    await render({ onRename });
    await type("   ");
    await commit();
    expect(container.querySelector("input")?.value).toBe("Support");
    await commit();
    await type("Help desk");
    await commit("Escape");
    expect(container.querySelector("input")?.value).toBe("Support");
    expect(onRename).not.toHaveBeenCalled();
  });

  it("holds the dialog busy while a rename is saving", async () => {
    let finish: Deferred | undefined;
    const onRename = vi.fn(() => {
      finish = deferred();
      return finish.promise;
    });
    const onBusyChange = vi.fn();
    await render({ onRename, onBusyChange });
    await type("Help desk");
    await commit();
    expect(onBusyChange).toHaveBeenLastCalledWith(true);
    await act(async () => finish?.resolve());
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
  });

  it.each([{ isComposing: true }, { keyCode: 229 }])(
    "neither saves nor reverts on the Enter or Escape that ends an IME composition (%o)",
    async (composition) => {
      const onRename = vi.fn(async () => undefined);
      await render({ onRename });
      await type("Help desk");
      const input = container.querySelector("input") as HTMLInputElement;
      const blur = vi.spyOn(input, "blur");
      const windowKeys: string[] = [];
      const onWindowKey = (event: KeyboardEvent) => windowKeys.push(event.key);
      window.addEventListener("keydown", onWindowKey);
      for (const key of ["Enter", "Escape"]) {
        await act(async () => {
          input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...composition }));
        });
      }
      window.removeEventListener("keydown", onWindowKey);
      expect(blur).not.toHaveBeenCalled();
      expect(input.value).toBe("Help desk");
      // The dialog's field keeps Escape from chat listeners behind it, as a plain Escape does.
      expect(windowKeys).not.toContain("Escape");
      await act(async () => {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      });
      expect(blur).toHaveBeenCalledOnce();
    },
  );

  it("falls back to the generic error when the failure message is blank", async () => {
    await render({
      onRename: async () => {
        throw new Error("   ");
      },
    });
    await type("Help desk");
    await commit();
    expect(container.textContent).toContain("Could not rename space");
  });

  it("shows neither rename nor delete to a space it cannot change", async () => {
    await render({
      space: { id: "space-a", name: "Personal", canRename: false, canDelete: false },
    });
    expect(container.querySelector("input")).toBeNull();
    // Every member can still customize their own settings for the space.
    expect(container.querySelector('[data-testid="space-setting-overrides"]')).not.toBeNull();
    expect(button("Delete space")).toBeUndefined();
  });

  it("names the bots that go with the space before deleting it", async () => {
    const onDelete = vi.fn(async () => undefined);
    await render({
      space: {
        id: "space-a",
        name: "Support",
        canRename: true,
        canDelete: true,
        botCount: 2,
      },
      onDelete,
    });
    await click("Delete space");
    expect(container.querySelector("h2")?.textContent).toBe("Delete Support and its 2 bots?");
    await click("Delete");
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("asks plainly when the space has no bots", async () => {
    await render({});
    await click("Delete space");
    expect(container.querySelector("h2")?.textContent).toBe("Delete Support?");
  });
});

const REPO_A = "https://example.com/owner/a";
const REPO_B = "https://example.com/owner/b";

function board(repositories: Board["repositories"]): Board {
  return {
    id: "board-a",
    spaceId: "space-a",
    name: "Board",
    ticketPrefix: "TASK",
    repositories,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

async function fill(label: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!input) throw new Error(`Missing ${label}`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submitRepository() {
  const form = container.querySelector("form[data-testid='space-board-repository-form']");
  if (!form) throw new Error("Missing repository form");
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderWithBoard(repositories: Board["repositories"]) {
  client.boards.get.mockResolvedValue(board(repositories));
  client.boards.rename.mockResolvedValue(board(repositories));
  await render({});
  await act(async () => {
    await vi.waitFor(() =>
      expect(container.querySelector('[data-testid="space-board-repositories"]')).not.toBeNull(),
    );
  });
}

describe("SpaceSettingsPanel repositories", () => {
  beforeEach(() => {
    setLabs(["board"]);
    client.boards.get.mockReset();
    client.boards.rename.mockReset();
  });
  afterEach(() => setLabs([]));

  it("is hidden while the board lab is off", async () => {
    setLabs([]);
    await render({});
    expect(container.querySelector('[data-testid="space-board-repositories"]')).toBeNull();
    expect(client.boards.get).not.toHaveBeenCalled();
  });

  it("saves an added repository in normalized form, as the default when none is set", async () => {
    await renderWithBoard([]);
    await fill("Repository URL", "https://Example.com/Owner/Repo.git");
    await fill("Aliases (comma-separated)", "api, repo, ,");
    await submitRepository();
    expect(client.boards.rename).toHaveBeenCalledWith({
      repositories: [
        { url: "https://example.com/owner/repo", aliases: ["api", "repo"], isDefault: true },
      ],
    });
  });

  it("adds after the existing repositories and keeps their default", async () => {
    await renderWithBoard([{ url: REPO_A, aliases: ["alpha"], isDefault: true }]);
    await fill("Repository URL", REPO_B);
    await submitRepository();
    expect(client.boards.rename).toHaveBeenCalledWith({
      repositories: [
        { url: REPO_A, aliases: ["alpha"], isDefault: true },
        { url: REPO_B, aliases: [], isDefault: false },
      ],
    });
  });

  it("marks another repository as the default", async () => {
    await renderWithBoard([
      { url: REPO_A, aliases: [], isDefault: true },
      { url: REPO_B, aliases: [], isDefault: false },
    ]);
    await click("Make default");
    expect(client.boards.rename).toHaveBeenCalledWith({
      repositories: [
        { url: REPO_A, aliases: [], isDefault: false },
        { url: REPO_B, aliases: [], isDefault: true },
      ],
    });
  });

  it("removes a repository and hands the default to the one left", async () => {
    await renderWithBoard([
      { url: REPO_A, aliases: [], isDefault: true },
      { url: REPO_B, aliases: ["bee"], isDefault: false },
    ]);
    await click(`Remove ${ticketLinkLabel(REPO_A)}`);
    expect(client.boards.rename).toHaveBeenCalledWith({
      repositories: [{ url: REPO_B, aliases: ["bee"], isDefault: true }],
    });
  });

  it("explains a link that is not a repository and saves nothing", async () => {
    await renderWithBoard([]);
    await fill("Repository URL", "not a repository");
    await submitRepository();
    expect(client.boards.rename).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Use a repository link such as https://example.com/owner/repo.",
    );
  });
});
