/**
 * Lane D cases: bots (reorder, restore, removePreview, email addresses), memory provider
 * configuration, groups.restore and the agentSkills reads/remove. Placeholders are expanded by
 * withIds; every email name starts with `ct${RUN_TAG}-` so reset can clear the global registry.
 *
 * Ids in inputs: `__sp1__`..`__sp3__` the case's Spaces, `__s-<key>__` the row `<userId>-<key>`,
 * `__skill__`/`__skillname__` the seeded skill, `__upper__` an upper-cased id for the email
 * lowercasing case.
 */
import type { Case, Seeded } from "./contract.mts";

type System = any;

export function laneDCases(system: System): Case[] {
  const old = new Date(Date.UTC(2020, 0, 1));
  const slightlyLater = new Date(Date.UTC(2020, 0, 1, 0, 0, 1));
  const addOtherUser = (seeded: Seeded) =>
    system.user.create({
      data: {
        id: `${seeded.userId}-other`,
        name: "Other",
        email: `${seeded.userId}-other@example.test`,
        emailVerified: true,
      },
    });
  const addBot = (
    seeded: Seeded,
    id: string,
    spaceIndex: 0 | 1 | 2,
    extra: Record<string, unknown> = {},
  ) =>
    system.bot.create({
      data: {
        id: `${seeded.userId}-${id}`,
        spaceId: seeded.spaces[spaceIndex],
        userId: seeded.userId,
        name: id,
        color: "blue",
        createdAt: old,
        updatedAt: old,
        ...extra,
      },
    });
  const addComputer = (seeded: Seeded, id: string, spaceIndex: 0 | 1 | 2) =>
    system.computer.create({
      data: {
        id: `${seeded.userId}-${id}`,
        spaceId: seeded.spaces[spaceIndex],
        userId: seeded.userId,
        scope: "team",
        scopeKey: `scope-${seeded.userId}-${id}`,
        homeKey: `home-${seeded.userId}-${id}`,
        kind: "linux",
        createdAt: old,
        updatedAt: old,
      },
    });
  const addGroup = (
    seeded: Seeded,
    id: string,
    name: string,
    spaceIndex: 0 | 1 | 2,
    extra: Record<string, unknown> = {},
  ) =>
    system.chatGroup.create({
      data: {
        id: `${seeded.userId}-${id}`,
        spaceId: seeded.spaces[spaceIndex],
        userId: seeded.userId,
        name,
        createdAt: old,
        updatedAt: old,
        ...extra,
      },
    });
  const addGroupMember = (seeded: Seeded, groupID: string, botID: string, createdAt = old) =>
    system.chatGroupMember.create({
      data: {
        id: `${seeded.userId}-gm-${groupID}-${botID}`,
        groupId: `${seeded.userId}-${groupID}`,
        botId: `${seeded.userId}-${botID}`,
        createdAt,
      },
    });
  const addSkill = (
    seeded: Seeded,
    id: string,
    spaceIndex: 0 | 1 | 2,
    extra: Record<string, unknown> = {},
  ) =>
    system.agentSkill.create({
      data: {
        id: `${seeded.userId}-${id}`,
        spaceId: seeded.spaces[spaceIndex],
        userId: seeded.userId,
        name: id,
        description: `${id} description`,
        content: `${id} content`,
        source: "user",
        createdAt: old,
        updatedAt: old,
        ...extra,
      },
    });
  const addSkillSpace = (seeded: Seeded, skillID: string, spaceIndex: 0 | 1 | 2) =>
    system.agentSkillSpace.create({
      data: {
        skillId: `${seeded.userId}-${skillID}`,
        spaceId: seeded.spaces[spaceIndex],
        userId: seeded.userId,
      },
    });
  const addAddress = (seeded: Seeded, botID: string, name: string) =>
    system.botEmailAddress.create({
      data: { name: `${seeded.userId}-${name}`, botId: `${seeded.userId}-${botID}` },
    });
  const memoryConfig = async (
    seeded: Seeded,
    provider: string,
    settings: Record<string, unknown>,
    options: { spaceIndex?: 0 | 1 | 2; defaultMemoryScope?: "isolated" | "shared" } = {},
  ) => {
    const spaceId = seeded.spaces[options.spaceIndex ?? 0];
    const secretId = `${seeded.userId}-msec-${provider}`;
    await system.secret.create({
      data: {
        id: secretId,
        userId: seeded.userId,
        spaceId,
        kind: "memory-provider",
        ciphertext: "sealed",
      },
    });
    await system.spaceMemoryConfig.create({
      data: {
        id: `${seeded.userId}-mcfg-${provider}`,
        spaceId,
        userId: seeded.userId,
        provider,
        settings,
        secretId,
        defaultMemoryScope: options.defaultMemoryScope ?? "isolated",
        createdAt: old,
        updatedAt: old,
      },
    });
  };
  const useMemberRole = (seeded: Seeded, spaceIndex: 0 | 1 | 2 = 0) =>
    system.spaceMember.updateMany({
      where: { spaceId: seeded.spaces[spaceIndex], userId: seeded.userId },
      data: { role: "member" },
    });

  const reorderSeed = async (seeded: Seeded) => {
    await addBot(seeded, "r1", 0, { position: 5 });
    await addBot(seeded, "r2", 0, { position: 1 });
    await addBot(seeded, "r3", 0, { position: 9 });
    await addBot(seeded, "rarch", 0, { archivedAt: old });
    await addBot(seeded, "rx", 1);
  };
  const reorder = (name: string, input: unknown, extra: Partial<Case> = {}): Case => ({
    name: `bot-order-${name}`,
    procedure: "bots.reorder",
    input,
    seed: reorderSeed,
    after: [{ procedure: "bots.list", input: {} }],
    ...extra,
  });

  const restoreSeed = (config: {
    archived?: boolean;
    computer?: "own-space" | "other-space";
    inUse?: number;
    shared?: boolean;
    otherUser?: boolean;
    spaceIndex?: 0 | 1 | 2;
  } = {}) => {
    return async (seeded: Seeded) => {
      const spaceIndex = config.spaceIndex ?? 0;
      const extra: Record<string, unknown> = {};
      if (config.archived) extra.archivedAt = old;
      if (config.otherUser) {
        await addOtherUser(seeded);
        extra.userId = `${seeded.userId}-other`;
      }
      for (let index = 0; index < (config.inUse ?? 0); index += 1) {
        const computer = `inuse${index}`;
        await addComputer(seeded, computer, spaceIndex);
        await addBot(seeded, `live${index}`, spaceIndex, { computerId: `${seeded.userId}-${computer}` });
      }
      if (config.computer === "own-space") {
        await addComputer(seeded, "targetcomputer", spaceIndex);
        extra.computerId = `${seeded.userId}-targetcomputer`;
        if (config.shared) {
          await addBot(seeded, "sharedlive", spaceIndex, { computerId: `${seeded.userId}-targetcomputer` });
        }
      }
      if (config.computer === "other-space") {
        const otherSpace = spaceIndex === 0 ? 1 : 0;
        await addComputer(seeded, "targetcomputer", otherSpace as 0 | 1 | 2);
        extra.computerId = `${seeded.userId}-targetcomputer`;
      }
      await addBot(seeded, "target", spaceIndex, extra);
    };
  };
  const restore = (name: string, input: unknown, seed: (seeded: Seeded) => Promise<void>, extra: Partial<Case> = {}): Case => ({
    name: `bot-restore-${name}`,
    procedure: "bots.restore",
    input,
    seed,
    after: [{ procedure: "bots.list", input: {} }, { procedure: "bots.listArchived", input: {} }],
    ...extra,
  });

  const previewSeed = (config: { targetUser?: "self" | "other"; memberRole?: boolean } = {}) => {
    return async (seeded: Seeded) => {
      if (config.targetUser === "other" || config.memberRole) await addOtherUser(seeded);
      if (config.memberRole) await useMemberRole(seeded);
      await addBot(seeded, "target", 0, config.targetUser === "other" ? { userId: `${seeded.userId}-other` } : {});
      await addBot(seeded, "mate", 0);
      await addBot(seeded, "mate2", 0);
      await addBot(seeded, "archivedmate", 0, { archivedAt: old });
      await addGroup(seeded, "gzeta", "Zeta group", 0);
      await addGroupMember(seeded, "gzeta", "target");
      await addGroupMember(seeded, "gzeta", "mate");
      await addGroup(seeded, "galpha", "Alpha group", 0);
      await addGroupMember(seeded, "galpha", "target");
      await addGroupMember(seeded, "galpha", "mate");
      await addGroupMember(seeded, "galpha", "mate2");
      await addGroup(seeded, "gmiddle", "Middle group", 0);
      await addGroupMember(seeded, "gmiddle", "target");
      await addGroupMember(seeded, "gmiddle", "archivedmate");
      await addGroup(seeded, "gother", "Other group", 0);
      await addGroupMember(seeded, "gother", "mate");
      await addGroup(seeded, "gcross", "A cross group", 1);
      await addGroupMember(seeded, "gcross", "target");
    };
  };
  const preview = (name: string, input: unknown, extra: Partial<Case> = {}): Case => ({
    name: `bot-preview-${name}`,
    procedure: "bots.removePreview",
    input,
    seed: previewSeed(),
    ...extra,
  });

  const emailSeed = async (seeded: Seeded) => {
    await addOtherUser(seeded);
    await addBot(seeded, "own1", 0);
    await addBot(seeded, "own2", 0);
    await addBot(seeded, "own3", 0);
    await addBot(seeded, "archived", 0, { archivedAt: old });
    await addBot(seeded, "otherspace", 1);
    await addBot(seeded, "otherbot", 0, { userId: `${seeded.userId}-other` });
    await addAddress(seeded, "own2", "a");
    await addAddress(seeded, "own3", "b");
    await addAddress(seeded, "archived", "c");
    await addAddress(seeded, "otherspace", "d");
    await addAddress(seeded, "otherbot", "e");
  };

  const addCase = (cases: Case[], testCase: Case) => {
    cases.push(testCase);
  };
  const list: Case[] = [];

  // bots.reorder
  addCase(list, reorder("all", { botIds: ["__s-r3__", "__s-r1__", "__s-r2__"] }));
  addCase(list, reorder("extra-key", { botIds: ["__s-r1__", "__s-r2__", "__s-r3__"], more: 1 }));
  addCase(list, reorder("missing-one", { botIds: ["__s-r1__", "__s-r2__"] }));
  addCase(list, reorder("single", { botIds: ["__s-r1__"] }));
  addCase(list, reorder("archived-included", { botIds: ["__s-r1__", "__s-r2__", "__s-r3__", "__s-rarch__"] }));
  addCase(list, reorder("other-space", { botIds: ["__s-rx__"] }));
  addCase(list, reorder("unknown", { botIds: ["nope"] }));
  addCase(list, reorder("duplicate", { botIds: ["__s-r1__", "__s-r1__", "__s-r2__"] }));
  addCase(list, reorder("empty", { botIds: [] }));
  addCase(list, reorder("not-array", { botIds: "x" }));
  addCase(list, reorder("item-number", { botIds: ["__s-r1__", 5] }));
  addCase(list, reorder("empty-strings", { botIds: ["", ""] }));
  addCase(list, reorder("no-input", undefined));
  addCase(list, reorder("null-input", null));
  addCase(list, reorder("array-input", [], { after: [] }));
  addCase(list, reorder("anonymous", { botIds: ["__s-r1__", "__s-r2__", "__s-r3__"] }, { anonymous: true, after: [] }));

  // bots.restore
  addCase(list, restore("archived-no-computer", { botId: "__s-target__" }, restoreSeed({ archived: true })));
  addCase(list, restore("live", { botId: "__s-target__" }, restoreSeed()));
  addCase(list, restore("archived-computer", { botId: "__s-target__" }, restoreSeed({ archived: true, computer: "own-space" })));
  addCase(list, restore("archived-computer-shared", { botId: "__s-target__" }, restoreSeed({ archived: true, computer: "own-space", shared: true, inUse: 2 })));
  addCase(list, restore("quota-reached", { botId: "__s-target__" }, restoreSeed({ archived: true, computer: "own-space", inUse: 2 })));
  addCase(list, restore("invisible-computer", { botId: "__s-target__" }, restoreSeed({ archived: true, computer: "other-space" })));
  addCase(list, restore("other-user-bot", { botId: "__s-target__" }, restoreSeed({ archived: true, otherUser: true })));
  addCase(list, restore("other-space-wrong-header", { botId: "__s-target__" }, restoreSeed({ archived: true, spaceIndex: 1 })));
  addCase(list, restore("other-space-own-header", { botId: "__s-target__" }, restoreSeed({ archived: true, spaceIndex: 1 }), { space: 1 }));
  addCase(list, restore("unknown", { botId: "nope" }, async () => {}));
  addCase(list, restore("empty-id", { botId: "" }, async () => {}));
  addCase(list, restore("id-number", { botId: 5 }, async () => {}));
  addCase(list, restore("no-input", undefined, async () => {}));
  addCase(list, restore("null-input", null, async () => {}));
  addCase(list, restore("array-input", [], async () => {}, { after: [] }));
  addCase(list, restore("anonymous", { botId: "__s-target__" }, restoreSeed({ archived: true }), { anonymous: true, after: [] }));

  // bots.removePreview
  addCase(list, preview("dissolves", { botId: "__s-target__" }));
  addCase(list, preview("own-bot-member-role", { botId: "__s-target__" }, { seed: previewSeed({ memberRole: true }) }));
  addCase(list, preview("other-bot-as-owner", { botId: "__s-target__" }, { seed: previewSeed({ targetUser: "other" }) }));
  addCase(list, preview("other-bot-as-member", { botId: "__s-target__" }, { seed: previewSeed({ targetUser: "other", memberRole: true }) }));
  addCase(list, preview("archived-target", { botId: "__s-target__" }, {
    seed: async (seeded) => {
      await previewSeed()(seeded);
      await system.bot.update({ where: { id: `${seeded.userId}-target` }, data: { archivedAt: old } });
    },
  }));
  addCase(list, preview("other-space-wrong-header", { botId: "__s-target__" }, {
    seed: async (seeded) => {
      await addBot(seeded, "target", 1);
    },
  }));
  addCase(list, preview("other-space-own-header", { botId: "__s-target__" }, {
    seed: async (seeded) => {
      await addBot(seeded, "target", 1);
      await addGroup(seeded, "g1", "Space two group", 1);
      await addGroupMember(seeded, "g1", "target");
    },
    space: 1,
  }));
  addCase(list, preview("unknown", { botId: "nope" }, { seed: async () => {} }));
  addCase(list, preview("empty-id", { botId: "" }, { seed: async () => {} }));
  addCase(list, preview("no-input", undefined, { seed: async () => {} }));
  addCase(list, preview("null-input", null, { seed: async () => {} }));
  addCase(list, preview("anonymous", { botId: "__s-target__" }, { anonymous: true }));

  // bots.emailAddress
  const emailAddress = (name: string, input: unknown, extra: Partial<Case> = {}): Case => ({
    name: `bot-email-${name}`,
    procedure: "bots.emailAddress",
    input,
    seed: emailSeed,
    ...extra,
  });
  addCase(list, emailAddress("claimed", { botId: "__s-own2__" }));
  addCase(list, emailAddress("unclaimed", { botId: "__s-own1__" }));
  addCase(list, emailAddress("other-users-bot", { botId: "__s-otherbot__" }));
  addCase(list, emailAddress("archived-bot", { botId: "__s-archived__" }));
  addCase(list, emailAddress("other-space", { botId: "__s-otherspace__" }));
  addCase(list, emailAddress("unknown", { botId: "nope" }));
  addCase(list, emailAddress("empty-id", { botId: "" }));
  addCase(list, emailAddress("id-number", { botId: 5 }));
  addCase(list, emailAddress("no-input", undefined));
  addCase(list, emailAddress("null-input", null));
  addCase(list, emailAddress("array-input", []));
  addCase(list, emailAddress("anonymous", { botId: "__s-own2__" }, { anonymous: true }));

  // bots.emailAddresses
  const emailAddresses = (name: string, input: unknown, extra: Partial<Case> = {}): Case => ({
    name: `bot-emails-${name}`,
    procedure: "bots.emailAddresses",
    input,
    seed: emailSeed,
    after: [{ procedure: "bots.emailAddress", input: { botId: "__s-own3__" } }],
    ...extra,
  });
  addCase(list, emailAddresses("list", {}));
  addCase(list, emailAddresses("other-space-own-header", {}, { space: 1 }));
  addCase(list, emailAddresses("no-attachments", {}, {
    seed: async () => {},
    after: [],
  }));
  addCase(list, emailAddresses("no-input", undefined));
  addCase(list, emailAddresses("null-input", null));
  addCase(list, emailAddresses("array-input", []));
  addCase(list, emailAddresses("anonymous", {}, { anonymous: true, after: [] }));

  // bots.claimEmailAddress
  const claim = (name: string, input: unknown, seed: (seeded: Seeded) => Promise<void>, extra: Partial<Case> = {}): Case => ({
    name: `bot-claim-${name}`,
    procedure: "bots.claimEmailAddress",
    input,
    seed,
    after: [
      { procedure: "bots.emailAddress", input: { botId: "__s-claimbot__" } },
      { procedure: "bots.emailAddresses", input: {} },
    ],
    ...extra,
  });
  const claimSeed = (config: { archived?: boolean; otherUser?: boolean; spaceIndex?: 0 | 1 | 2; existing?: "same" | "different" } = {}) => {
    return async (seeded: Seeded) => {
      const spaceIndex = config.spaceIndex ?? 0;
      if (config.otherUser) await addOtherUser(seeded);
      await addBot(seeded, "claimbot", spaceIndex, {
        ...(config.archived ? { archivedAt: old } : {}),
        ...(config.otherUser ? { userId: `${seeded.userId}-other` } : {}),
      });
      if (config.existing === "same") await addAddress(seeded, "claimbot", "claim");
      if (config.existing === "different") await addAddress(seeded, "claimbot", "firstname");
    };
  };
  addCase(list, claim("success", { botId: "__s-claimbot__", name: "__s-claim__" }, claimSeed()));
  addCase(list, claim("uppercase-trim", { botId: "__s-claimbot__", name: "  __upper__  " }, claimSeed()));
  addCase(list, claim("same-again", { botId: "__s-claimbot__", name: "__s-claim__" }, claimSeed({ existing: "same" })));
  addCase(list, claim("different-existing", { botId: "__s-claimbot__", name: "__s-claim__" }, claimSeed({ existing: "different" })));
  addCase(list, claim("name-taken", { botId: "__s-claimbot__", name: "__s-taken__" }, async (seeded) => {
    await addBot(seeded, "claimbot", 0);
    await addBot(seeded, "otherbot", 0);
    await addAddress(seeded, "otherbot", "taken");
  }));
  addCase(list, claim("reserved", { botId: "__s-claimbot__", name: "admin" }, claimSeed()));
  addCase(list, claim("reserved-prefix", { botId: "__s-claimbot__", name: "support-team" }, claimSeed()));
  addCase(list, claim("dots", { botId: "__s-claimbot__", name: "a..b" }, claimSeed()));
  addCase(list, claim("too-short", { botId: "__s-claimbot__", name: "A" }, claimSeed()));
  addCase(list, claim("too-long", { botId: "__s-claimbot__", name: "a".repeat(65) }, claimSeed()));
  addCase(list, claim("characters", { botId: "__s-claimbot__", name: "a b" }, claimSeed()));
  addCase(list, claim("other-user-bot", { botId: "__s-claimbot__", name: "__s-claim__" }, claimSeed({ otherUser: true })));
  addCase(list, claim("archived-bot", { botId: "__s-claimbot__", name: "__s-claim__" }, claimSeed({ archived: true })));
  addCase(list, claim("other-space-wrong-header", { botId: "__s-claimbot__", name: "__s-claim__" }, claimSeed({ spaceIndex: 1 })));
  addCase(list, claim("other-space-own-header", { botId: "__s-claimbot__", name: "__s-claim__" }, claimSeed({ spaceIndex: 1 }), { space: 1 }));
  addCase(list, claim("unknown", { botId: "nope", name: "__s-claim__" }, async () => {}));
  addCase(list, claim("missing-name", { botId: "__s-claimbot__" }, claimSeed()));
  addCase(list, claim("name-number", { botId: "__s-claimbot__", name: 5 }, claimSeed()));
  addCase(list, claim("empty-id", { botId: "", name: "__s-claim__" }, claimSeed()));
  addCase(list, claim("no-input", undefined, async () => {}));
  addCase(list, claim("null-input", null, async () => {}));
  addCase(list, claim("array-input", [], async () => {}));
  addCase(list, claim("anonymous", { botId: "__s-claimbot__", name: "__s-claim__" }, claimSeed(), { anonymous: true }));

  // memory.providerConfig
  const config = (name: string, provider: string, settings: Record<string, unknown>, options?: { spaceIndex?: 0 | 1 | 2; defaultMemoryScope?: "isolated" | "shared" }, extra: Partial<Case> = {}): Case => ({
    name: `mem-config-${name}`,
    procedure: "memory.providerConfig",
    input: {},
    seed: async (seeded) => {
      await memoryConfig(seeded, provider, settings, options);
    },
    ...extra,
  });
  addCase(list, { name: "mem-config-none", procedure: "memory.providerConfig", input: {} });
  addCase(list, config("supermemory-cloud", "supermemory", { mode: "cloud" }));
  addCase(list, config("supermemory-local", "supermemory", { baseUrl: "http://mem.test" }));
  addCase(list, config("serenity", "serenity", { brainLabel: " Team ", allowWrites: "true" }));
  addCase(list, config("serenity-endpoint", "serenity", { endpoint: "http://serenity.test" }));
  addCase(list, config("honcho-local", "honcho", { mode: "local", baseUrl: "http://honcho.test", workspaceId: "ws1" }));
  addCase(list, config("honcho-cloud", "honcho", { workspaceId: "ws1" }));
  addCase(list, config("hindsight-cloud", "hindsight", { mode: "cloud" }));
  addCase(list, config("hindsight-local", "hindsight", { mode: "local", baseUrl: "http://hindsight.test" }));
  addCase(list, config("unknown-provider", "someone", { mode: "cloud" }));
  addCase(list, config("non-string-settings", "supermemory", {
    mode: "cloud", count: 5, nested: { a: 1 }, list: ["x"], flag: true, nothing: null,
  }));
  addCase(list, config("other-space-wrong-header", "supermemory", { mode: "cloud" }, { spaceIndex: 1 }));
  addCase(list, config("other-space-own-header", "supermemory", { mode: "cloud" }, { spaceIndex: 1 }, { space: 1 }));
  addCase(list, config("space-two-header", "supermemory", { mode: "cloud" }, { spaceIndex: 2 }, { space: 2 }));
  addCase(list, { name: "mem-config-no-input", procedure: "memory.providerConfig", input: undefined });
  addCase(list, { name: "mem-config-null-input", procedure: "memory.providerConfig", input: null });
  addCase(list, { name: "mem-config-array-input", procedure: "memory.providerConfig", input: [] });
  addCase(list, { name: "mem-config-anonymous", procedure: "memory.providerConfig", input: {}, anonymous: true });

  // memory.setDefaultScope
  const setScope = (name: string, input: unknown, seed: (seeded: Seeded) => Promise<void>, extra: Partial<Case> = {}): Case => ({
    name: `mem-scope-${name}`,
    procedure: "memory.setDefaultScope",
    input,
    seed,
    after: [{ procedure: "memory.providerConfig", input: {} }],
    ...extra,
  });
  addCase(list, setScope("shared", { defaultMemoryScope: "shared" }, (seeded) => memoryConfig(seeded, "supermemory", { mode: "cloud" })));
  addCase(list, setScope("isolated", { defaultMemoryScope: "isolated" }, (seeded) => memoryConfig(seeded, "honcho", { mode: "local" }, { defaultMemoryScope: "shared" })));
  addCase(list, setScope("member", { defaultMemoryScope: "shared" }, async (seeded) => {
    await useMemberRole(seeded);
    await memoryConfig(seeded, "supermemory", { mode: "cloud" });
  }));
  addCase(list, setScope("no-config", { defaultMemoryScope: "shared" }, async () => {}));
  addCase(list, setScope("config-other-space", { defaultMemoryScope: "shared" }, (seeded) => memoryConfig(seeded, "supermemory", { mode: "cloud" }, { spaceIndex: 1 })));
  addCase(list, setScope("own-other-space", { defaultMemoryScope: "shared" }, (seeded) => memoryConfig(seeded, "supermemory", { mode: "cloud" }, { spaceIndex: 1 }), { space: 1 }));
  addCase(list, setScope("missing-scope", {}, async () => {}));
  addCase(list, setScope("invalid-scope", { defaultMemoryScope: "x" }, async () => {}));
  addCase(list, setScope("scope-number", { defaultMemoryScope: 5 }, async () => {}));
  addCase(list, setScope("scope-null", { defaultMemoryScope: null }, async () => {}));
  addCase(list, setScope("extra-key", { defaultMemoryScope: "shared", more: 1 }, (seeded) => memoryConfig(seeded, "supermemory", { mode: "cloud" })));
  addCase(list, setScope("no-input", undefined, async () => {}));
  addCase(list, setScope("array-input", [], async () => {}, { after: [] }));
  addCase(list, setScope("anonymous", { defaultMemoryScope: "shared" }, (seeded) => memoryConfig(seeded, "supermemory", { mode: "cloud" }), { anonymous: true, after: [] }));

  // groups.restore
  const restoreGroup = (name: string, input: unknown, seed: (seeded: Seeded) => Promise<void>, extra: Partial<Case> = {}): Case => ({
    name: `grp-restore-${name}`,
    procedure: "groups.restore",
    input,
    seed,
    after: [{ procedure: "groups.list", input: {} }],
    ...extra,
  });
  const groupSeed = (config: { archived?: boolean; members?: "archived-pair" | "live-group" | "empty" | "cross-space" } = {}) => {
    return async (seeded: Seeded) => {
      const archived = config.archived ? { archivedAt: old } : {};
      await addGroup(seeded, "g1", "Restored group", 0, archived);
      switch (config.members) {
        case "live-group":
          await addBot(seeded, "able", 0);
          await addBot(seeded, "barch", 0, { archivedAt: old });
          await addGroupMember(seeded, "g1", "able");
          await addGroupMember(seeded, "g1", "barch", slightlyLater);
          break;
        case "empty":
          break;
        case "cross-space":
          await addBot(seeded, "xspace", 1, { archivedAt: old });
          await addGroupMember(seeded, "g1", "xspace");
          break;
        default:
          await addBot(seeded, "a", 0, { archivedAt: old });
          await addBot(seeded, "b", 0, { archivedAt: old });
          await addGroupMember(seeded, "g1", "a");
          await addGroupMember(seeded, "g1", "b", slightlyLater);
          break;
      }
    };
  };
  addCase(list, restoreGroup("archived-pair", { groupId: "__s-g1__" }, groupSeed({ archived: true })));
  addCase(list, restoreGroup("live-group", { groupId: "__s-g1__" }, groupSeed({ members: "live-group" })));
  addCase(list, restoreGroup("empty-group", { groupId: "__s-g1__" }, groupSeed({ archived: true, members: "empty" })));
  addCase(list, restoreGroup("quota-rollback", { groupId: "__s-g1__" }, async (seeded) => {
    await groupSeed({ archived: true })(seeded);
    // Two computers already backed by live bots fill the quota of two.
    await addComputer(seeded, "inuse1", 0);
    await addBot(seeded, "live1", 0, { computerId: `${seeded.userId}-inuse1` });
    await addComputer(seeded, "inuse2", 0);
    await addBot(seeded, "live2", 0, { computerId: `${seeded.userId}-inuse2` });
    // The first member has no computer (its update must roll back), the second needs a third one.
    await addComputer(seeded, "newcomputer", 0);
    await system.bot.update({ where: { id: `${seeded.userId}-b` }, data: { computerId: `${seeded.userId}-newcomputer` } });
  }));
  addCase(list, restoreGroup("quota-shared-computer", { groupId: "__s-g1__" }, async (seeded) => {
    await groupSeed({ archived: true })(seeded);
    await addComputer(seeded, "inuse1", 0);
    await addBot(seeded, "live1", 0, { computerId: `${seeded.userId}-inuse1` });
    await addComputer(seeded, "inuse2", 0);
    await addBot(seeded, "live2", 0, { computerId: `${seeded.userId}-inuse2` });
    await addComputer(seeded, "sharedcomputer", 0);
    await addBot(seeded, "live3", 0, { computerId: `${seeded.userId}-sharedcomputer` });
    await system.bot.update({ where: { id: `${seeded.userId}-b` }, data: { computerId: `${seeded.userId}-sharedcomputer` } });
  }));
  addCase(list, restoreGroup("cross-space-member", { groupId: "__s-g1__" }, groupSeed({ archived: true, members: "cross-space" })));
  addCase(list, restoreGroup("other-space-group", { groupId: "__s-g1__" }, async (seeded) => {
    await addGroup(seeded, "g1", "Space two group", 1, { archivedAt: old });
  }));
  addCase(list, restoreGroup("unknown", { groupId: "nope" }, async () => {}));
  addCase(list, restoreGroup("empty-id", { groupId: "" }, async () => {}));
  addCase(list, restoreGroup("id-number", { groupId: 5 }, async () => {}));
  addCase(list, restoreGroup("no-input", undefined, async () => {}));
  addCase(list, restoreGroup("null-input", null, async () => {}));
  addCase(list, restoreGroup("array-input", [], async () => {}, { after: [] }));
  addCase(list, restoreGroup("anonymous", { groupId: "__s-g1__" }, groupSeed({ archived: true }), { anonymous: true, after: [] }));

  // agentSkills.list
  const listSkills = (name: string, input: unknown, seed?: (seeded: Seeded) => Promise<void>, extra: Partial<Case> = {}): Case => ({
    name: `skill-list-${name}`,
    procedure: "agentSkills.list",
    input,
    ...(seed ? { seed } : {}),
    ...extra,
  });
  addCase(list, listSkills("basic", {}));
  addCase(list, listSkills("shadow-builtin", {}, (seeded) => addSkill(seeded, "Rakazo", 0)));
  addCase(list, listSkills("shadow-trimmed", {}, (seeded) => addSkill(seeded, " rakazo ", 0)));
  addCase(list, listSkills("plugin", {}, (seeded) => addSkill(seeded, "plugin-skill", 0, { source: "plugin" })));
  addCase(list, listSkills("tampered-source", {}, (seeded) => addSkill(seeded, "weird-skill", 0, { source: "weird" })));
  addCase(list, listSkills("all-spaces", {}, (seeded) => addSkill(seeded, "shared-skill", 1, { allSpaces: true })));
  addCase(list, listSkills("joined", {}, async (seeded) => {
    await addSkill(seeded, "joined-skill", 1);
    await addSkillSpace(seeded, "joined-skill", 0);
    await addSkillSpace(seeded, "joined-skill", 2);
  }));
  addCase(list, listSkills("not-visible", {}, (seeded) => addSkill(seeded, "hidden-skill", 1)));
  addCase(list, listSkills("other-user", {}, async (seeded) => {
    await addOtherUser(seeded);
    await system.agentSkill.create({
      data: {
        id: `${seeded.userId}-other-skill`,
        spaceId: seeded.spaces[0],
        userId: `${seeded.userId}-other`,
        name: "Other skill",
        description: "",
        content: "body",
        source: "user",
        createdAt: old,
        updatedAt: old,
      },
    });
  }));
  addCase(list, listSkills("no-input", undefined));
  addCase(list, listSkills("null-input", null));
  addCase(list, listSkills("array-input", []));
  addCase(list, listSkills("string-input", "x"));
  addCase(list, listSkills("anonymous", {}, undefined, { anonymous: true }));

  // agentSkills.get
  const get = (name: string, input: unknown, seed?: (seeded: Seeded) => Promise<void>, extra: Partial<Case> = {}): Case => ({
    name: `skill-get-${name}`,
    procedure: "agentSkills.get",
    input,
    ...(seed ? { seed } : {}),
    ...extra,
  });
  addCase(list, get("builtin-id", { skillId: "builtin:Rakazo" }));
  addCase(list, get("builtin-id-interrogate", { skillId: "builtin:Interrogate" }));
  addCase(list, get("builtin-name", { name: "  rAkAzO " }));
  addCase(list, get("builtin-unknown-id", { skillId: "builtin:Nope" }));
  addCase(list, get("user-id", { skillId: "__skill__" }));
  addCase(list, get("user-name", { name: "__skillname__" }));
  addCase(list, get("user-name-case", { name: "__skillupper__" }));
  addCase(list, get("availability", { skillId: "__s-sharedskill__" }, (seeded) => addSkill(seeded, "sharedskill", 1, { allSpaces: true })));
  addCase(list, get("availability-joined", { skillId: "__s-joinedskill__" }, async (seeded) => {
    await addSkill(seeded, "joinedskill", 1);
    await addSkillSpace(seeded, "joinedskill", 0);
    await addSkillSpace(seeded, "joinedskill", 2);
  }));
  addCase(list, get("not-available", { skillId: "__s-hiddenskill__" }, (seeded) => addSkill(seeded, "hiddenskill", 1)));
  addCase(list, get("other-user", { skillId: "__s-otherskill__" }, async (seeded) => {
    await addOtherUser(seeded);
    await system.agentSkill.create({
      data: {
        id: `${seeded.userId}-otherskill`,
        spaceId: seeded.spaces[0],
        userId: `${seeded.userId}-other`,
        name: "Other skill",
        description: "",
        content: "body",
        source: "user",
        createdAt: old,
        updatedAt: old,
      },
    });
  }));
  addCase(list, get("plugin", { skillId: "__s-pluginsk__" }, (seeded) => addSkill(seeded, "pluginsk", 0, { source: "plugin" })));
  addCase(list, get("tampered-source", { skillId: "__s-weirdsk__" }, (seeded) => addSkill(seeded, "weirdsk", 0, { source: "weird" })));
  addCase(list, get("both-ids", { skillId: "__skill__", name: "Rakazo" }));
  addCase(list, get("empty", {}));
  addCase(list, get("blank-name", { name: "   " }));
  addCase(list, get("empty-name", { name: "" }));
  addCase(list, get("empty-skill-id", { skillId: "" }));
  addCase(list, get("name-number", { name: 5 }));
  addCase(list, get("name-too-long", { name: "a".repeat(81) }));
  addCase(list, get("extra-keys", { skillId: "__skill__", more: 1 }));
  addCase(list, get("unknown", { skillId: "nope" }));
  addCase(list, get("no-input", undefined));
  addCase(list, get("null-input", null));
  addCase(list, get("array-input", []));
  addCase(list, get("anonymous", { skillId: "builtin:Rakazo" }, undefined, { anonymous: true }));

  // agentSkills.remove
  const remove = (name: string, input: unknown, seed?: (seeded: Seeded) => Promise<void>, extra: Partial<Case> = {}): Case => ({
    name: `skill-remove-${name}`,
    procedure: "agentSkills.remove",
    input,
    ...(seed ? { seed } : {}),
    after: [{ procedure: "agentSkills.list", input: {} }],
    ...extra,
  });
  addCase(list, remove("user", { skillId: "__skill__" }));
  addCase(list, remove("with-joins", { skillId: "__skill__" }, (seeded) =>
    system.agentSkillSpace.create({
      data: { skillId: seeded.skillId, spaceId: seeded.spaces[1], userId: seeded.userId },
    })));
  addCase(list, remove("all-spaces", { skillId: "__s-sharedskill__" }, (seeded) => addSkill(seeded, "sharedskill", 1, { allSpaces: true })));
  addCase(list, remove("plugin", { skillId: "__s-pluginsk__" }, (seeded) => addSkill(seeded, "pluginsk", 0, { source: "plugin" })));
  addCase(list, remove("builtin", { skillId: "builtin:Rakazo" }));
  addCase(list, remove("tampered-source", { skillId: "__s-weirdsk__" }, (seeded) => addSkill(seeded, "weirdsk", 0, { source: "weird" })));
  addCase(list, remove("not-available", { skillId: "__s-hiddenskill__" }, (seeded) => addSkill(seeded, "hiddenskill", 1)));
  addCase(list, remove("other-user", { skillId: "__s-otherskill__" }, async (seeded) => {
    await addOtherUser(seeded);
    await system.agentSkill.create({
      data: {
        id: `${seeded.userId}-otherskill`,
        spaceId: seeded.spaces[0],
        userId: `${seeded.userId}-other`,
        name: "Other skill",
        description: "",
        content: "body",
        source: "user",
        createdAt: old,
        updatedAt: old,
      },
    });
  }));
  addCase(list, remove("unknown", { skillId: "nope" }));
  addCase(list, remove("empty-id", { skillId: "" }));
  addCase(list, remove("id-number", { skillId: 5 }));
  addCase(list, remove("id-null", { skillId: null }));
  addCase(list, remove("no-input", undefined));
  addCase(list, remove("null-input", null));
  addCase(list, remove("array-input", [], undefined, { after: [] }));
  addCase(list, remove("anonymous", { skillId: "__skill__" }, undefined, { anonymous: true, after: [] }));

  return list;
}

