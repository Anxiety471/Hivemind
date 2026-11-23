// @vitest-environment jsdom

import type { DriveFile } from "@rakazo/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fileContentUrl, uploadFormFields, uploadMobileFile } from "./file-upload";

const state = vi.hoisted(() => ({
  rpc: vi.fn(),
  fetch: vi.fn(),
  base64: vi.fn(async (_uri: string) => "aGk="),
  fileSize: 4,
}));

vi.mock("../api/api", () => ({
  captureApiRequestContext: async () => ({
    apiBase: "https://api.example.test",
    headers: { authorization: "Bearer token-a", "x-rakazo-space-id": "space-1" },
  }),
  currentApiBase: () => "https://api.example.test",
  selectedSpaceId: () => "space-1",
  rpc: state.rpc,
}));
vi.mock("../api/server-headers", () => ({ fetchServer: state.fetch }));
vi.mock("expo-file-system", () => {
  class Directory {
    uri: string;
    constructor(...parts: Array<string | { uri: string }>) {
      this.uri = parts.map((part) => (typeof part === "string" ? part : part.uri)).join("/");
    }
    get exists() {
      return false;
    }
    create() {}
    delete() {}
  }
  class File extends Directory {
    override get exists() {
      return true;
    }
    info() {
      return { size: state.fileSize };
    }
    base64() {
      return state.base64(this.uri);
    }
    override create() {}
    writeSync() {}
    override delete() {}
  }
  return { Directory, File, Paths: { cache: { uri: "file:///cache" } } };
});

class OrderedFormData {
  entries: Array<[string, unknown]> = [];
  append(name: string, value: unknown) {
    this.entries.push([name, value]);
  }
}

const driveFile: DriveFile = {
  id: "file-1",
  botId: "bot-1",
  groupId: null,
  runId: null,
  folderId: null,
  source: "chat",
  name: "notes.txt",
  slug: null,
  description: null,
  mimeType: "text/plain",
  size: 4,
  hash: "hash-1",
  version: 1,
  versionCount: 1,
  trashedAt: null,
  createdAt: "2026-11-22T10:00:00.000Z",
  updatedAt: "2026-11-22T10:00:00.000Z",
  contentUrl: "/api/v1/files/file-1/content",
};

beforeEach(() => {
  state.rpc.mockReset();
  state.fetch.mockReset();
  state.base64.mockReset().mockResolvedValue("aGk=");
  state.fileSize = 4;
  vi.stubGlobal("FormData", OrderedFormData);
});

describe("mobile Drive upload", () => {
  it("puts every metadata field before the file part", () => {
    const fields = uploadFormFields({
      folderId: "folder-1",
      botId: "bot-1",
      groupId: "group-1",
      source: "chat",
      name: "notes.txt",
      description: "A note",
      mimeType: "text/plain",
      clientNonce: "nonce-1",
    });
    expect(fields).toEqual([
      ["folderId", "folder-1"],
      ["botId", "bot-1"],
      ["groupId", "group-1"],
      ["source", "chat"],
      ["name", "notes.txt"],
      ["description", "A note"],
      ["mimeType", "text/plain"],
      ["clientNonce", "nonce-1"],
    ]);
  });

  it("streams the file part last and accepts the plain Drive file answer", async () => {
    state.fetch.mockResolvedValue({ status: 201, ok: true, json: async () => driveFile });
    await expect(
      uploadMobileFile({
        uri: "file:///cache/notes.txt",
        name: "notes.txt",
        mimeType: "text/plain",
        botId: "bot-1",
        source: "chat",
        clientNonce: "nonce-1",
      }),
    ).resolves.toMatchObject({ id: "file-1" });
    const [, init] = state.fetch.mock.calls[0]!;
    const form = init.body as OrderedFormData;
    expect(form.entries.at(-1)?.[0]).toBe("file");
    expect(form.entries.slice(0, -1).map(([name]) => name)).toEqual([
      "folderId",
      "botId",
      "groupId",
      "source",
      "name",
      "description",
      "mimeType",
      "clientNonce",
    ]);
  });

  it("falls back to the chat attachment RPC when the server has no Drive endpoint", async () => {
    state.fetch.mockResolvedValue({ status: 404, ok: false, json: async () => ({}) });
    state.rpc.mockResolvedValue({
      id: "artifact-1",
      botId: "bot-1",
      groupId: null,
      runId: null,
      name: "notes.txt",
      description: null,
      mimeType: "text/plain",
      size: 4,
      hash: "hash-1",
      version: 1,
      createdAt: "2026-11-22T10:00:00.000Z",
    });
    const uploaded = await uploadMobileFile({
      uri: "file:///cache/notes.txt",
      name: "notes.txt",
      mimeType: "text/plain",
      size: 4,
      botId: "bot-1",
      clientNonce: "nonce-1",
    });
    expect(uploaded.id).toBe("artifact-1");
    expect(state.rpc).toHaveBeenCalledWith(
      "artifacts/create",
      expect.objectContaining({
        botId: "bot-1",
        name: "notes.txt",
        contentBase64: "aGk=",
        clientNonce: "nonce-1",
      }),
      expect.objectContaining({ requestContext: expect.anything() }),
    );
  });

  it("refuses a file past the base64 fallback's limit instead of reading it", async () => {
    state.fetch.mockResolvedValue({ status: 404, ok: false, json: async () => ({}) });
    state.fileSize = 11 * 1024 * 1024;
    await expect(
      uploadMobileFile({
        uri: "file:///cache/movie.mp4",
        name: "movie.mp4",
        mimeType: "video/mp4",
        size: state.fileSize,
        botId: "bot-1",
      }),
    ).rejects.toMatchObject({ status: 413 });
    expect(state.base64).not.toHaveBeenCalled();
  });

  it("builds a content URL with the Space and a download flag", () => {
    expect(fileContentUrl("file-1", { spaceId: "space-1" })).toBe(
      "https://api.example.test/api/v1/files/file-1/content?spaceId=space-1",
    );
    expect(fileContentUrl("file-1", { spaceId: null, download: true })).toBe(
      "https://api.example.test/api/v1/files/file-1/content?download=1",
    );
  });
});
