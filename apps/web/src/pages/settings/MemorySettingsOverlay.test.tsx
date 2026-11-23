// @vitest-environment jsdom

import type { MemoryProviderDescriptor, SpaceMemoryConfig } from "@rakazo/contracts";
import { flush } from "@rakazo/core/test-async";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const memory = vi.hoisted(() => ({
  providers: vi.fn(),
  providerConfig: vi.fn(),
  list: vi.fn(),
  budget: vi.fn(),
  connectProvider: vi.fn(),
  updateProvider: vi.fn(),
  setDefaultScope: vi.fn(),
  disconnectProvider: vi.fn(),
  roamer: vi.fn(),
  setRoamer: vi.fn(),
}));
vi.mock("../../lib/query/rpc", () => {
  const client = { memory };
  return {
    rpc: client,
    rpcForSpace: () => client,
    createSpaceRpc: () => client,
    selectedSpaceId: () => null,
  };
});
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) => String.raw(parts, ...values),
  }),
}));
vi.mock("../space/KnowledgeSection", () => ({ SpaceMemorySection: () => null }));

import { MemorySettingsOverlay } from "./MemorySettingsOverlay";

const providers: MemoryProviderDescriptor[] = [
  {
    id: "notes",
    displayName: "Notes",
    fields: [
      { key: "apiKey", label: "API key", kind: "secret", required: true, minLength: 8 },
      { key: "team", label: "Team", kind: "text", required: false, scopesSecrets: true },
    ],
  },
  {
    id: "journal",
    displayName: "Journal",
    fields: [{ key: "token", label: "Token", kind: "secret", required: true, minLength: 8 }],
  },
];
const connected: SpaceMemoryConfig = {
  provider: "journal",
  settings: {},
  defaultMemoryScope: "isolated",
  updatedAt: "2026-11-01T00:00:00.000Z",
  connectionLabel: "Journal Cloud",
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const call of Object.values(memory)) call.mockReset();
  memory.providers.mockResolvedValue(providers);
  memory.roamer.mockResolvedValue({
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
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

/** Lets a read or a save answer, and the screen draw what it answered. */
async function settle() {
  for (let turn = 0; turn < 3; turn += 1) {
    await act(flush);
  }
}

async function render(config: SpaceMemoryConfig | null) {
  const onConfigChange = vi.fn();
  const onBusyChange = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <MemorySettingsOverlay
          embedded
          onClose={() => {}}
          config={config}
          onConfigChange={onConfigChange}
          onBusyChange={onBusyChange}
        />
      </QueryClientProvider>,
    ),
  );
  await settle();
  return { onConfigChange, onBusyChange, client };
}

function button(name: string) {
  const found = [...host.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === name,
  );
  if (!found) throw new Error(`No button named ${name}`);
  return found;
}

function input(name: string) {
  const label = [...host.querySelectorAll("label")].find(
    (candidate) => candidate.textContent === name,
  );
  const found = label ? host.querySelector(`#${CSS.escape(label.htmlFor)}`) : null;
  if (!(found instanceof HTMLInputElement)) throw new Error(`No input labelled ${name}`);
  return found;
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
  await settle();
}

async function type(name: string, value: string) {
  const field = input(name);
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    set?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("connects the provider picked from the ones the server describes", async () => {
  const saved = { ...connected, defaultMemoryScope: "shared" as const };
  memory.connectProvider.mockResolvedValue(saved);
  const { onConfigChange, onBusyChange } = await render(null);
  await click(button("Connect memory provider"));
  const select = [...host.querySelectorAll<HTMLElement>('[role="combobox"]')].find(
    (candidate) => !candidate.hasAttribute("aria-label"),
  )!;
  expect(select.textContent).toBe("Notes");
  expect(input("API key")).toBeDefined();

  await act(async () => select.click());
  const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
  expect(options.map((option) => option.textContent)).toEqual(["Notes", "Journal"]);
  await act(async () => options[1]?.click());
  expect(() => input("API key")).toThrow();
  await type("Token", "token_12345678");
  await click(button("Advanced"));
  await click(button("Shared"));
  await click(button("Connect"));

  expect(memory.connectProvider.mock.calls[0]?.[0]).toEqual({
    provider: "journal",
    settings: {},
    credentials: { token: "token_12345678" },
    defaultMemoryScope: "shared",
  });
  expect(onConfigChange).toHaveBeenCalledWith(saved);
  expect(onBusyChange.mock.calls.map(([busy]) => busy)).toContain(true);
  expect(onBusyChange).toHaveBeenLastCalledWith(false);
});

it("shows every bot's outcome and changes", async () => {
  memory.roamer.mockResolvedValue({
    enabled: true,
    intervalMinutes: 360,
    lastRunAt: "2026-11-22T23:30:32.920Z",
    lastError: "1 bot failed",
    lastChanges: 1,
    lastModel: "deepseek-v4.1-flash",
    lastFailures: [],
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
        model: "deepseek-v4.1-flash",
        changes: [],
        checkedAt: "2026-11-22T23:30:33.920Z",
      },
      {
        kind: "shared",
        id: "space-1",
        name: "Team",
        status: "failed",
        error: "model HTTP 429",
        changes: [],
        checkedAt: "2026-11-22T23:30:34.920Z",
      },
    ],
    retryAt: null,
    retryAttempt: 0,
  });
  await render(null);
  expect(host.textContent).toContain("Last run failed");
  expect(host.textContent).toContain("1 of 3 checks failed");
  expect(host.textContent).toContain("Shared memory (Team)");
  await click(button("View results"));
  expect(document.body.textContent).toContain("Crumb");
  expect(document.body.textContent).toContain("MEMORY.md: 100 → 90 bytes");
  expect(document.body.textContent).toContain("Hatcha");
  expect(document.body.textContent).toContain("1 with no changes");
  expect(document.body.textContent).toContain("Shared memory (Team)");
  expect(document.body.textContent).toContain("model HTTP 429");
  await act(async () => {
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle();
  expect(document.querySelector("[data-run-results]")).toBeNull();
});

it("shows which targets failed and when the next retry runs", async () => {
  memory.roamer.mockResolvedValue({
    enabled: true,
    intervalMinutes: 360,
    lastRunAt: "2026-11-22T23:30:32.920Z",
    lastError: "1 bot failed",
    lastChanges: 0,
    lastModel: null,
    lastFailures: [{ kind: "bot", id: "bot-1", name: "Crumb", error: "model HTTP 429" }],
    retryAt: "2026-11-22T23:45:32.920Z",
    retryAttempt: 1,
  });
  await render(null);
  expect(host.textContent).toContain("Last run failed");
  expect(host.textContent).toContain("1 bot failed");
  expect(host.textContent).toContain("Crumb");
  expect(host.textContent).toContain("Retry at 7:45 AM · attempt 1");
  await click(button("View results"));
  expect(document.body.textContent).toContain("model HTTP 429");
});

it("shows why a connection failed, and keeps the form", async () => {
  memory.connectProvider.mockRejectedValueOnce(new Error("The key was rejected"));
  memory.connectProvider.mockRejectedValueOnce(new Error(""));
  const { onConfigChange } = await render(null);
  await click(button("Connect memory provider"));
  await type("API key", "key_12345678");
  await click(button("Connect"));
  expect(host.textContent).toContain("The key was rejected");
  await click(button("Connect"));
  expect(host.textContent).not.toContain("The key was rejected");
  expect(host.textContent).toContain("Could not connect Notes");
  expect(onConfigChange).not.toHaveBeenCalled();
  expect(input("API key").value).toBe("key_12345678");
  expect(button("Connect").disabled).toBe(false);
});

it("names a connected provider and saves an edit without its stored secret", async () => {
  const config = { ...connected, provider: "notes", settings: { team: "ops" } };
  const saved = { ...config, updatedAt: "2026-11-02T00:00:00.000Z" };
  memory.updateProvider.mockResolvedValue(saved);
  const { onConfigChange } = await render(config);
  expect(host.textContent).toContain("Notes");
  expect(host.textContent).toContain("Journal Cloud");
  expect(host.textContent).toContain("Connected");

  await click(button("Edit"));
  expect(input("API key").placeholder).toBe("Saved");
  expect(input("Team").value).toBe("ops");
  await click(button("Save"));
  expect(memory.updateProvider.mock.calls[0]?.[0]).toEqual({
    settings: { team: "ops" },
    credentials: {},
  });
  expect(onConfigChange).toHaveBeenCalledWith(saved);
  // Saved, so the form closes.
  expect(() => button("Save")).toThrow();
  expect(button("Edit")).toBeDefined();
});

it("reports a failed edit until it is cancelled", async () => {
  memory.updateProvider.mockRejectedValue(new Error(""));
  await render({ ...connected, provider: "notes" });
  await click(button("Edit"));
  await click(button("Save"));
  expect(host.textContent).toContain("Could not save Notes");
  await click(button("Cancel"));
  expect(host.textContent).not.toContain("Could not save Notes");
});

it("changes the default scope and disconnects", async () => {
  const shared = { ...connected, defaultMemoryScope: "shared" as const };
  memory.setDefaultScope.mockResolvedValue(shared);
  memory.disconnectProvider.mockResolvedValue({ ok: true });
  const { onConfigChange } = await render(connected);
  await click(button("Isolated"));
  expect(memory.setDefaultScope).not.toHaveBeenCalled();
  await click(button("Shared"));
  expect(memory.setDefaultScope.mock.calls[0]?.[0]).toEqual({ defaultMemoryScope: "shared" });
  expect(onConfigChange).toHaveBeenLastCalledWith(shared);

  await click(button("Disconnect"));
  expect(memory.disconnectProvider).toHaveBeenCalledOnce();
  expect(onConfigChange).toHaveBeenLastCalledWith(null);
});

it("reads the connection and what is remembered again after a change", async () => {
  memory.disconnectProvider.mockResolvedValue(undefined);
  const { client } = await render(connected);
  const invalidated = vi.spyOn(client, "invalidateQueries");
  await click(button("Disconnect"));
  const keys = JSON.stringify(invalidated.mock.calls.map(([filter]) => filter?.queryKey));
  for (const read of ["providerConfig", "list", "budget"])
    expect(keys).toContain(`"memory","${read}"`);
});

it("offers a retry when the providers fail to load, and keeps the connection once they do", async () => {
  memory.providers.mockRejectedValueOnce(new Error("offline"));
  await render(connected);
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
  expect(() => button("Disconnect")).toThrow();
  await click(button("Retry"));
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(button("Edit")).toBeDefined();
});

it("still shows a connection whose provider the server does not describe", async () => {
  memory.providers.mockRejectedValue(Object.assign(new Error("not found"), { code: "NOT_FOUND" }));
  await render({ ...connected, provider: "retired", connectionLabel: undefined });
  expect(host.textContent).toContain("retired");
  expect(() => button("Edit")).toThrow();
  expect(button("Disconnect")).toBeDefined();
});
