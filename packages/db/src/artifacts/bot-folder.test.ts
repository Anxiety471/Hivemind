import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { ensureBotDriveFolder } from "./bot-folder.js";

describe("ensureBotDriveFolder", () => {
  it("reuses an active folder already bound to the bot", async () => {
    const create = vi.fn();
    const db = {
      fileFolder: {
        findFirst: vi.fn().mockResolvedValue({ id: "folder-bot" }),
        updateMany: vi.fn(),
        create,
      },
      bot: { findFirst: vi.fn() },
    } as unknown as PrismaClient;

    await expect(
      ensureBotDriveFolder(db, { spaceId: "s1", userId: "u1", botId: "b1", botName: "Researcher" }),
    ).resolves.toBe("folder-bot");
    expect(create).not.toHaveBeenCalled();
  });

  it("adopts an unbound active root folder matching the bot name", async () => {
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "folder-unbound" });
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const create = vi.fn();
    const db = {
      fileFolder: { findFirst, updateMany, create },
      bot: { findFirst: vi.fn() },
    } as unknown as PrismaClient;

    await expect(
      ensureBotDriveFolder(db, { spaceId: "s1", userId: "u1", botId: "b1", botName: "Researcher" }),
    ).resolves.toBe("folder-unbound");
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "folder-unbound", spaceId: "s1", botId: null, trashedAt: null },
      data: { botId: "b1" },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("sanitizes the bot name, recovers from a P2002 race, and falls back with a suffix", async () => {
    const p2002 = Object.assign(new Error("unique"), { code: "P2002" });
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "folder-winner" });
    const create = vi.fn().mockRejectedValueOnce(p2002);
    const db = {
      fileFolder: { findFirst, updateMany: vi.fn(), create },
      bot: {
        findFirst: vi.fn().mockResolvedValue({ name: "  Ops / Helper \n Bot ", userId: "u-owner" }),
      },
    } as unknown as PrismaClient;

    await expect(
      ensureBotDriveFolder(db, { spaceId: "s1", userId: "", botId: "b1" }),
    ).resolves.toBe("folder-winner");
    expect(create).toHaveBeenCalledWith({
      data: {
        spaceId: "s1",
        parentId: null,
        botId: "b1",
        createdByUserId: "u-owner",
        name: "Ops Helper Bot",
      },
      select: { id: true },
    });

    const findSecond = vi.fn().mockResolvedValue(null);
    const createSecond = vi
      .fn()
      .mockRejectedValueOnce(p2002)
      .mockResolvedValueOnce({ id: "folder-suffixed" });
    const db2 = {
      fileFolder: { findFirst: findSecond, updateMany: vi.fn(), create: createSecond },
      bot: { findFirst: vi.fn() },
    } as unknown as PrismaClient;

    await expect(
      ensureBotDriveFolder(db2, { spaceId: "s1", userId: "u1", botId: "b2", botName: "Ops Bot" }),
    ).resolves.toBe("folder-suffixed");
    expect(createSecond).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({ name: "Ops Bot (2)" }),
      }),
    );
  });
});
