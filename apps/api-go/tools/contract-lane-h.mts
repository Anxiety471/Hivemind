/**
 * Lane H cases: bots.templates, skills.list, onboarding.start, agentSecrets.list, audit.events,
 * vault.activity, computer.dismissUpdate/dismissDiskWarning and boards.list/get/rename.
 *
 * All seeds are rows of the case's own Spaces and people. Placeholders are expanded by withIds;
 * `__s-<key>__` addresses `<userId>-<key>`.
 */
import type { Case, Seeded } from "./contract.mts";

type System = any;

const OLD = new Date(Date.UTC(2021, 0, 1));
const at = (seconds: number) => new Date(OLD.getTime() + seconds * 1000);

export function laneHCases(system: System): Case[] {
  // ---- bots.templates -----------------------------------------------------------------------
  const seedTemplates = (options: { foreign?: boolean } = {}) => async (seeded: Seeded) => {
    const user = seeded.userId;
    const bot = (id: string, spaceId: string, extra: Record<string, unknown> = {}) =>
      system.bot.create({
        data: { id: `${user}-${id}`, spaceId, userId: user, name: id, color: "blue", updatedAt: OLD, ...extra },
      });
    const imported = (id: string, botId: string, importKey: string, source: string, spaceId: string, userId = user) =>
      system.agentImport.create({
        data: { id: `${user}-${id}`, spaceId, userId, botId, source, importKey, created: {} },
      });
    await bot("tpl1", seeded.spaces[0]);
    await bot("tplarch", seeded.spaces[0], { archivedAt: OLD });
    await bot("tplspace2", seeded.spaces[1]);
    await imported("ai1", `${user}-tpl1`, "template:morning-briefing", "template", seeded.spaces[0]);
    await imported("ai2", `${user}-tplarch`, "template:pr-reviewer", "template", seeded.spaces[0]);
    await imported("ai3", `${user}-tplspace2`, "template:topic-watch", "template", seeded.spaces[1]);
    // A same-key import of another source is not a template create.
    await bot("tpldoc", seeded.spaces[0]);
    await imported("ai4", `${user}-tpldoc`, "template:inbox-triage", "document", seeded.spaces[0]);
    if (options.foreign) {
      const other = `${user}-other`;
      await system.user.create({ data: { id: other, name: "Other", email: `${other}@example.test`, emailVerified: true } });
      await bot("tplother", seeded.spaces[0], { userId: other });
      await imported("ai5", `${user}-tplother`, "template:topic-watch", "template", seeded.spaces[0], other);
    }
  };
  const templates = (name: string, extra: Partial<Case> = {}): Case => ({
    name: `btpl-${name}`, procedure: "bots.templates", input: undefined, ...extra,
  });

  // ---- skills.list --------------------------------------------------------------------------
  const playbook = {
    whenToUse: "when", inputs: ["a"], steps: ["one"], howToCheck: "check",
    whatToReturn: "back", approvalBoundaries: "ask", failureHandling: "stop",
  };
  const seedSkills = (options: {
    none?: boolean; space2?: boolean; otherOwner?: string; status?: string; recording?: unknown;
    playbook?: unknown; second?: boolean; archived?: boolean; otherSpace?: boolean;
  } = {}) => async (seeded: Seeded) => {
    const user = seeded.userId;
    await system.bot.create({
      data: {
        id: `${user}-skbot`, spaceId: seeded.spaces[options.otherSpace ? 1 : 0], userId: user,
        name: "Skills bot", color: "blue", updatedAt: OLD,
        ...(options.archived ? { archivedAt: OLD } : {}),
      },
    });
    await system.bot.create({
      data: { id: `${user}-skbot2`, spaceId: seeded.spaces[0], userId: user, name: "Other bot", color: "blue", updatedAt: OLD },
    });
    if (options.none) return;
    const skill = (id: string, botId: string, spaceId: string, updated: number, extra: Record<string, unknown> = {}) =>
      system.taughtSkill.create({
        data: {
          id: `${user}-${id}`, spaceId, botId, userId: options.otherOwner ?? user,
          name: `Skill ${id}`, goal: `goal ${id}`, status: options.status ?? "draft",
          playbook: (options.playbook === undefined ? playbook : options.playbook) as never,
          recording: (options.recording ?? {
            events: [{ at: "2021-01-01T00:00:00.000Z", kind: "key", key: "Enter" }],
            snapshots: [{ at: "2021-01-01T00:00:01.000Z", summary: "screen", hash: "h" }],
          }) as never,
          createdAt: at(updated), updatedAt: at(updated), ...extra,
        },
      });
    await skill("sk1", `${user}-skbot`, seeded.spaces[options.otherSpace ? 1 : 0], 1);
    if (options.second !== false) await skill("sk2", `${user}-skbot`, seeded.spaces[0], 2);
    if (options.space2) await skill("skx", `${user}-skbot`, seeded.spaces[1], 3);
    await skill("skotherbot", `${user}-skbot2`, seeded.spaces[0], 4);
  };
  const skList = (name: string, input: unknown, seed?: Case["seed"], extra: Partial<Case> = {}): Case => ({
    name: `sk-list-${name}`, procedure: "skills.list", input, ...(seed ? { seed } : {}), ...extra,
  });

  // ---- onboarding.start ---------------------------------------------------------------------
  const seedObBot = (options: {
    thread?: boolean; archived?: boolean; space?: 0 | 1 | 2; messages?: number; summary?: string;
  } = {}) => async (seeded: Seeded) => {
    const user = seeded.userId;
    const spaceId = seeded.spaces[options.space ?? 0];
    await system.bot.create({
      data: {
        id: `${user}-obb`, spaceId, userId: user, name: "Onboarding", color: "blue", updatedAt: OLD,
        ...(options.archived ? { archivedAt: OLD } : {}),
      },
    });
    if (options.thread === false) return;
    await system.thread.create({
      data: {
        id: `${user}-th-obb`, spaceId, userId: user, botId: `${user}-obb`, nextMessageSeq: options.messages ?? 0,
        ...(options.summary === undefined ? {} : { historyCompactionSummary: options.summary }),
      },
    });
    for (let index = 0; index < (options.messages ?? 0); index += 1) {
      await system.message.create({
        data: {
          id: `${user}-th-obb-m${index}`, threadId: `${user}-th-obb`, seq: index, role: "bot",
          blocks: [{ kind: "text", text: `message ${index}` }], createdAt: at(index),
        },
      });
    }
  };
  const obStart = (name: string, seed?: Case["seed"], extra: Partial<Case> = {}): Case => ({
    name: `ob-start-${name}`, procedure: "onboarding.start", input: { botId: "__s-obb__" },
    ...(seed ? { seed } : {}), ...extra,
  });

  // ---- agentSecrets.list --------------------------------------------------------------------
  const seedAgentSecrets = (options: {
    spaceVault?: boolean; override?: boolean; role?: string; noMembership?: boolean;
  } = {}) => async (seeded: Seeded) => {
    const user = seeded.userId;
    await system.user.create({
      data: { id: `${user}-other`, name: "Other", email: `${user}-other@example.test`, emailVerified: true },
    });
    const secret = (id: string, name: string, auth: unknown, spaceId: string | null, userId = user) =>
      system.vaultCredential.create({
        data: {
          id: `${user}-${id}`, userId, spaceId, name, origin: "https://example.test",
          auth: auth as never, ciphertext: "sealed", createdAt: at(1), updatedAt: at(1),
        },
      });
    await secret("as1", "netbird-setup-key", { type: "command" }, null);
    await secret("as2", "lower-case", { type: "command" }, null);
    await secret("as3", "path", { type: "command" }, null);
    await secret("as4", "1bad", { type: "command" }, null);
    await secret("as5", "login-item", { type: "login" }, null);
    await secret("as6", "broken-auth", "nope", null);
    await secret("as7", "null-auth", null, null);
    await secret("as8", "someone-else", { type: "command" }, null, `${user}-other`);
    if (options.spaceVault) await secret("as9", "space-key", { type: "command" }, seeded.spaces[0]);
    if (options.override) {
      await system.spaceSettingOverride.create({
        data: { spaceId: seeded.spaces[0], userId: user, setting: "credentials" },
      });
    }
    if (options.role) {
      await system.spaceMember.update({
        where: { spaceId_userId: { spaceId: seeded.spaces[0], userId: user } }, data: { role: options.role },
      });
    }
    if (options.noMembership) {
      await system.spaceMember.delete({ where: { spaceId_userId: { spaceId: seeded.spaces[0], userId: user } } });
    }
  };
  const asList = (name: string, seed?: Case["seed"], extra: Partial<Case> = {}): Case => ({
    name: `as-list-${name}`, procedure: "agentSecrets.list", input: undefined,
    ...(seed ? { seed } : {}), ...extra,
  });

  // ---- audit.events -------------------------------------------------------------------------
  const seedAudit = (options: {
    role?: string; noMember?: boolean; foreignOnly?: boolean; metadata?: string; odd?: boolean; many?: number; fraction?: boolean;
  } = {}) => async (seeded: Seeded) => {
    const user = seeded.userId;
    const row = (id: string, extra: Record<string, unknown> = {}) => ({
      id: `${user}-${id}`,
      organizationId: seeded.orgId,
      spaceId: seeded.spaces[0],
      spaceName: "Space 1",
      actorType: "user",
      actorId: user,
      actorLabel: "Contract User",
      action: "space.renamed",
      targetType: "space",
      targetId: seeded.spaces[0],
      targetLabel: "Space 1",
      outcome: "success",
      metadata: { setting: "x" },
      createdAt: at(1),
      ...extra,
    });
    const rows = [
      row("av1"),
      row("av2", { createdAt: at(2), action: "member.role_changed", spaceId: seeded.spaces[1], actorType: "bot", actorId: `${user}-bb`, actorLabel: "Bot B", metadata: { role: "admin", count: 2, ok: true, none: null } }),
      row("av3", { createdAt: at(3), action: "credential.used", actorType: "bot", actorId: `${user}-bb`, runId: `${user}-run`, threadId: `${user}-th` }),
      row("av4", { createdAt: at(1), spaceId: null, spaceName: null }),
    ];
    if (options.many) {
      for (let index = 0; index < options.many; index += 1) {
        rows.push(row(`avm${index}`, { createdAt: at(1 + index), action: "ticket.created", metadata: { index } }));
      }
    }
    if (options.odd) rows.push(row("avo", { createdAt: at(9), actorType: "robot", outcome: "maybe" }));
    if (options.fraction) {
      rows.push(row("avfrac", { createdAt: new Date(OLD.getTime() + 2123), action: "fraction.event" }));
    }
    if (options.metadata === "list") {
      rows.push(row("avj", {
        createdAt: at(10),
        metadata: { good: "yes", bad: { nested: 1 }, list: [1, 2], number: 1.5, flag: false, nil: null } as never,
      }));
    }
    if (options.metadata === "not-object") {
      rows.push(row("avj", { createdAt: at(10), metadata: "plain text" as never }));
    }
    if (options.foreignOnly) {
      await system.organization.create({
        data: { id: `${seeded.orgId}-f`, name: "Foreign", slug: `foreign-${user}`, createdAt: OLD },
      });
      await system.auditEvent.create({
        data: { ...row("avf", { createdAt: at(20) }), organizationId: `${seeded.orgId}-f` } as never,
      });
      return;
    }
    for (const entry of rows) await system.auditEvent.create({ data: entry as never });
    if (options.role) {
      await system.member.update({ where: { id: `${seeded.orgId}-m` }, data: { role: options.role } });
    }
    if (options.noMember) {
      await system.member.delete({ where: { id: `${seeded.orgId}-m` } });
    }
  };
  const auditCase = (name: string, input: unknown, seed?: Case["seed"], extra: Partial<Case> = {}): Case => ({
    name: `audit-${name}`, procedure: "audit.events", input, ...(seed ? { seed } : {}), ...extra,
  });

  // ---- vault.activity -----------------------------------------------------------------------
  const seedVaultActivity = (options: {
    scope?: "account" | "space"; override?: boolean; noItem?: boolean; many?: number;
    longActor?: boolean; longSite?: boolean; twins?: boolean;
  } = {}) => async (seeded: Seeded) => {
    const user = seeded.userId;
    const account = options.scope !== "space";
    await system.vaultCredential.create({
      data: {
        id: `${user}-vc1`, userId: user, spaceId: account ? null : seeded.spaces[0], name: "travel-login",
        origin: "https://example.test", auth: { type: "login" } as never, ciphertext: "sealed",
        createdAt: at(1), updatedAt: at(1),
      },
    });
    if (options.override) {
      await system.spaceSettingOverride.create({
        data: { spaceId: seeded.spaces[0], userId: user, setting: "credentials" },
      });
    }
    if (options.noItem) return;
    const target = `${user}-vc1`;
    // Chats a use may name: the actor's own bot and group chats, and someone else's.
    await system.bot.create({ data: { id: `${user}-vabot`, spaceId: seeded.spaces[0], userId: user, name: "Chat bot", color: "blue", updatedAt: OLD } });
    await system.chatGroup.create({ data: { id: `${user}-vagroup`, spaceId: seeded.spaces[0], userId: user, name: "My group", updatedAt: OLD } });
    await system.thread.create({ data: { id: `${user}-vath`, spaceId: seeded.spaces[0], userId: user, botId: `${user}-vabot` } });
    await system.thread.create({ data: { id: `${user}-vagth`, spaceId: seeded.spaces[0], userId: user, groupId: `${user}-vagroup` } });
    await system.bot.create({ data: { id: `${user}-vabot2`, spaceId: seeded.spaces[0], userId: `${user}-other`, name: "Other bot", color: "blue", updatedAt: OLD } });
    await system.thread.create({ data: { id: `${user}-vaoth`, spaceId: seeded.spaces[0], userId: `${user}-other`, botId: `${user}-vabot2` } });
    const use = (id: string, seconds: number, extra: Record<string, unknown> = {}) =>
      system.auditEvent.create({
        data: {
          id: `${user}-${id}`, organizationId: seeded.orgId, spaceId: seeded.spaces[0],
          actorType: "bot", actorId: `${user}-bb`, actorLabel: "Bot B", action: "credential.used",
          targetType: "vault_credential", targetId: target, targetLabel: "travel-login",
          outcome: "success", createdAt: at(seconds),
          metadata: { site: "https://a.test", tool: "browser" }, ...extra,
        } as never,
      });
    await use("va1", 2, { threadId: `${user}-vath`, runId: `${user}-run1` });
    await use("va2", 3, { threadId: `${user}-vagth`, metadata: { site: "https://b.test" } });
    await use("va3", 4, { threadId: `${user}-vaoth`, metadata: { site: "https://c.test" } });
    await use("va4", 5, { metadata: { site: 7 } });
    await use("va5", 6, { metadata: "text" as never });
    await use("va6", 7, { threadId: `${user}-missing-thread`, metadata: {} });
    if (options.twins) {
      await use("vadup-a", 8, { targetLabel: null, threadId: `${user}-vath`, metadata: { site: "https://a.test" } });
      await use("vadup-b", 8, { threadId: `${user}-vath`, metadata: { site: "https://a.test" } });
      await use("vadup-c", 9, { targetLabel: null, metadata: {} });
    }
    if (options.many) {
      for (let index = 0; index < options.many; index += 1) await use(`vam${index}`, 100 + index, { metadata: {} });
    }
    if (options.longActor) await use("val", 50, { actorLabel: "x".repeat(201), metadata: {} });
    if (options.longSite) await use("vals", 51, { metadata: { site: "x".repeat(2049) } });
  };
  const va = (name: string, input: unknown, seed?: Case["seed"], extra: Partial<Case> = {}): Case => ({
    name: `va-${name}`, procedure: "vault.activity", input, ...(seed ? { seed } : {}), ...extra,
  });

  // ---- computer dismissals ------------------------------------------------------------------
  const seedDismiss = () => async (seeded: Seeded) => {
    const user = seeded.userId;
    const computer = (id: string, spaceId: string, extra: Record<string, unknown> = {}) =>
      system.computer.create({
        data: {
          id: `${user}-${id}`, spaceId, userId: user, kind: "local", scope: "team",
          scopeKey: `${user}-${id}-sk`, homeKey: `${user}-${id}-hk`, createdAt: OLD, updatedAt: OLD, ...extra,
        },
      });
    const bot = (id: string, spaceId: string, computerId: string | null, extra: Record<string, unknown> = {}) =>
      system.bot.create({
        data: { id: `${user}-${id}`, spaceId, userId: user, name: id, color: "blue", computerId, updatedAt: OLD, ...extra },
      });
    const update = (id: string, computerId: string, status: string) =>
      system.computerUpdate.create({
        data: {
          id: `${user}-${id}`, computerId, botId: `${user}-b1`, action: "update", status, stage: "preparing",
          createdAt: at(1), updatedAt: at(1),
        },
      });
    await computer("dc1", seeded.spaces[0], { diskUsedBytes: BigInt(1), diskFreeBytes: BigInt(2) });
    await computer("dc2", seeded.spaces[0]);
    await computer("dc3", seeded.spaces[0], { diskUsedBytes: BigInt(0), diskFreeBytes: BigInt(0) });
    await computer("dc4", seeded.spaces[0]);
    await computer("dcx", seeded.spaces[1], { diskUsedBytes: BigInt(50), diskFreeBytes: BigInt(50) });
    await bot("b1", seeded.spaces[0], `${user}-dc1`);
    await bot("b2", seeded.spaces[0], `${user}-dc2`);
    await bot("b3", seeded.spaces[0], `${user}-dc3`);
    await bot("b4", seeded.spaces[0], `${user}-dc4`, { archivedAt: OLD });
    await bot("bx", seeded.spaces[1], `${user}-dcx`);
    await update("du1", `${user}-dc1`, "failed");
    await update("du2", `${user}-dc1`, "completed");
    await update("du3", `${user}-dcx`, "failed");
    await update("du4", `${user}-dc4`, "failed");
  };
  const dismiss = (name: string, input: unknown, seed: Case["seed"] = seedDismiss(), extra: Partial<Case> = {}): Case => ({
    name: `cd-dismiss-${name}`, procedure: "computer.dismissUpdate", input, seed, ...extra,
  });
  const disk = (name: string, input: unknown, seed: Case["seed"] = seedDismiss(), extra: Partial<Case> = {}): Case => ({
    name: `cd-disk-${name}`, procedure: "computer.dismissDiskWarning", input, seed, ...extra,
  });

  // ---- boards -------------------------------------------------------------------------------
  const withLab = async (seeded: Seeded) => {
    await system.user.update({ where: { id: seeded.userId }, data: { labs: ["board"] } });
  };
  const seedBoard = (options: { lab?: boolean; board?: boolean; ticket?: boolean; space?: 0 | 1 | 2 } = {}) => async (seeded: Seeded) => {
    if (options.lab !== false) await withLab(seeded);
    if (options.board === false) return;
    const spaceId = seeded.spaces[options.space ?? 0];
    await system.board.create({
      data: {
        id: `${seeded.userId}-bd`, spaceId, name: "Board", ticketPrefix: "RAK", nextNumber: 4,
        createdAt: OLD, updatedAt: OLD,
      },
    });
    if (options.ticket) {
      await system.ticket.create({
        data: {
          id: `${seeded.userId}-bdt`, boardId: `${seeded.userId}-bd`, spaceId, number: 3,
          title: "First", status: "todo", priority: "normal", createdByUserId: seeded.userId,
          createdAt: OLD, updatedAt: OLD,
        },
      });
    }
  };
  const boards = (procedure: string, prefix: string, name: string, input: unknown, seed?: Case["seed"], extra: Partial<Case> = {}): Case => ({
    name: `${prefix}-${name}`, procedure, input, ...(seed ? { seed } : {}), ...extra,
  });
  // Input-shape cases run with the lab on so they reach the parse; the lazy create then never runs.
  const rename = (name: string, input: unknown, seed: Case["seed"] = seedBoard({ board: false }), extra: Partial<Case> = {}) =>
    boards("boards.rename", "bd-rename", name, input, seed, extra);

  // Ticket-returning procedures: `mentionsMe` is optional in the contract, and TypeScript's
  // toTicketDto (packages/db/src/artifacts/board.ts:93-118) never sets it, so the field must be
  // absent from every answer. The seeds use mention-looking text (status review/blocked) so a
  // server-side flag would be true rather than a merely omitted false.
  const seedLabOnly = async (seeded: Seeded) => {
    await withLab(seeded);
  };
  const seedTicketDto = (options: { status?: string; title?: string } = {}) => async (seeded: Seeded) => {
    await withLab(seeded);
    const spaceId = seeded.spaces[0];
    await system.board.create({
      data: {
        id: `${seeded.userId}-tkbd`, spaceId, name: "Board", ticketPrefix: "RAK", nextNumber: 2,
        createdAt: OLD, updatedAt: OLD,
      },
    });
    await system.ticket.create({
      data: {
        id: `${seeded.userId}-tkt`, boardId: `${seeded.userId}-tkbd`, spaceId, number: 1,
        title: options.title ?? "First", status: options.status ?? "todo", priority: "normal",
        createdByUserId: seeded.userId, createdAt: OLD, updatedAt: OLD,
      },
    });
  };
  const ticketDto = (procedure: string, prefix: string, name: string, input: unknown, seed?: Case["seed"], extra: Partial<Case> = {}): Case => ({
    name: `${prefix}-${name}`, procedure, input, ...(seed ? { seed } : {}), ...extra,
  });

  return [
    // bots.templates -------------------------------------------------------------------------
    templates("empty"),
    templates("live-import", { seed: seedTemplates() }),
    templates("foreign-user", { seed: seedTemplates({ foreign: true }) }),
    templates("space-two", { seed: seedTemplates(), space: 1 }),
    templates("junk-input-is-ignored", { input: { anything: 1 } }),
    templates("anonymous", { anonymous: true }),

    // skills.list ----------------------------------------------------------------------------
    skList("empty", { botId: "__s-skbot2__" }, seedSkills({ none: true })),
    skList("lists-newest-first", { botId: "__s-skbot__" }, seedSkills()),
    skList("other-bot", { botId: "__s-skbot__" }, seedSkills({ second: false })),
    skList("space-two-excluded", { botId: "__s-skbot__" }, seedSkills({ space2: true })),
    skList("another-person-recording-is-empty", { botId: "__s-skbot__" }, seedSkills({ otherOwner: "someone-else" })),
    skList("another-person-broken-recording-still-lists", { botId: "__s-skbot__" }, seedSkills({ otherOwner: "someone-else", recording: { events: [{ kind: "nope" }] } })),
    skList("playbook-is-coerced", { botId: "__s-skbot__" }, seedSkills({ playbook: { whenToUse: 5, inputs: "no", steps: [1, null], howToCheck: true } })),
    skList("playbook-is-a-list", { botId: "__s-skbot__" }, seedSkills({ playbook: ["x"] })),
    skList("odd-status-fails-the-output-check", { botId: "__s-skbot__" }, seedSkills({ status: "weird" })),
    skList("bad-recording-fails-the-output-check", { botId: "__s-skbot__" }, seedSkills({ recording: { events: [{ kind: "key" }] } })),
    skList("unknown-recording-kind-fails-the-output-check", { botId: "__s-skbot__" }, seedSkills({ recording: { events: [{ at: "2021-01-01T00:00:00.000Z", kind: "tap" }] } })),
    skList("unknown-bot", { botId: "no-such-bot" }),
    skList("archived-bot", { botId: "__s-skbot__" }, seedSkills({ archived: true })),
    skList("other-space-bot", { botId: "__s-skbot__" }, seedSkills({ otherSpace: true })),
    skList("missing-bot", {}),
    skList("null-bot", { botId: null }),
    skList("empty-bot", { botId: "" }),
    skList("number-bot", { botId: 5 }),
    skList("array-bot", { botId: [1] }),
    skList("extra-key", { botId: "__s-skbot2__", extra: true }, seedSkills({ none: true })),
    skList("anonymous", { botId: "__s-skbot2__" }, seedSkills({ none: true }), { anonymous: true }),

    // onboarding.start -----------------------------------------------------------------------
    obStart("empty-thread", seedObBot()),
    obStart("with-messages", seedObBot({ messages: 2 })),
    obStart("no-thread", seedObBot({ thread: false })),
    obStart("archived-bot", seedObBot({ archived: true, messages: 1 })),
    obStart("space-two", seedObBot({ space: 1 }), { space: 1 }),
    obStart("other-space-bot", seedObBot({ space: 1 })),
    obStart("unknown-bot"),
    obStart("plaintext-summary", seedObBot({ summary: "legacy summary" })),
    obStart("unreadable-summary", seedObBot({ summary: "rkz1:nokey:AAAA" })),
    obStart("missing-bot", undefined, { input: {} }),
    obStart("null-bot", undefined, { input: { botId: null } }),
    obStart("empty-bot", undefined, { input: { botId: "" } }),
    obStart("number-bot", undefined, { input: { botId: 7 } }),
    obStart("array-bot", undefined, { input: { botId: ["x"] } }),
    obStart("extra-key", seedObBot(), { input: { botId: "__s-obb__", extra: true } }),
    obStart("anonymous", undefined, { anonymous: true }),

    // agentSecrets.list ----------------------------------------------------------------------
    asList("account-vault", seedAgentSecrets()),
    asList("space-vault-hidden-by-default", seedAgentSecrets({ spaceVault: true })),
    asList("space-vault-with-override", seedAgentSecrets({ spaceVault: true, override: true })),
    asList("member-refused", seedAgentSecrets({ role: "member" })),
    asList("admin-refused", seedAgentSecrets({ role: "admin" })),
    asList("owner-in-a-role-list", seedAgentSecrets({ role: "owner,member" })),
    asList("no-membership", seedAgentSecrets({ noMembership: true })),
    asList("junk-input-is-ignored", undefined, { seed: seedAgentSecrets(), input: { anything: 1 } }),
    asList("anonymous", seedAgentSecrets(), { anonymous: true }),

    // audit.events ---------------------------------------------------------------------------
    auditCase("owner-sees-all", {}, seedAudit()),
    auditCase("member-sees-own", {}, seedAudit({ role: "member" })),
    auditCase("member-actor-filter-overridden", { actorId: "__s-bb__" }, seedAudit({ role: "member" })),
    auditCase("admin-sees-all", {}, seedAudit({ role: "admin" })),
    auditCase("guest-refused", {}, seedAudit({ role: "guest" })),
    auditCase("no-member-refused", {}, seedAudit({ noMember: true })),
    auditCase("foreign-organization-only", {}, seedAudit({ foreignOnly: true })),
    auditCase("space-filter", { spaceId: "__sp2__" }),
    auditCase("action-filter", { action: "space.renamed" }),
    auditCase("actor-filter", { actorId: "__s-bb__" }),
    auditCase("from-filter", { from: "2021-01-01T00:00:02.000Z" }),
    auditCase("to-filter", { to: "2021-01-01T00:00:02.000Z" }),
    auditCase("from-and-to", { from: "2021-01-01T00:00:01.000Z", to: "2021-01-01T00:00:03.000Z" }),
    auditCase("offset-from", { from: "2021-01-01T05:30:02.000+05:30" }),
    auditCase("negative-offset-to", { to: "2020-12-31T19:00:03.000-05:00" }),
    auditCase("sub-ms-from", { from: "2021-01-01T00:00:02.1235Z" }, seedAudit({ fraction: true })),
    auditCase("sub-ms-to", { to: "2021-01-01T00:00:02.1235Z" }, seedAudit({ fraction: true })),
    auditCase("empty-filter-values-are-ignored", { spaceId: "", actorId: "", action: "" }),
    auditCase("limit-two-pages", { limit: 2 }, undefined, { paginate: true }),
    auditCase("limit-one-walk", { limit: 1 }, undefined, { paginate: true }),
    auditCase("cursor-unknown", { cursor: "no-such-event" }),
    auditCase("cursor-foreign-organization", { cursor: "__s-avf__" }, seedAudit({ foreignOnly: true })),
    auditCase("limit-zero", { limit: 0 }),
    auditCase("limit-501", { limit: 501 }),
    auditCase("limit-fraction", { limit: 1.5 }),
    auditCase("limit-string", { limit: "10" }),
    auditCase("from-invalid", { from: "yesterday" }),
    auditCase("to-number", { to: 5 }),
    auditCase("space-null", { spaceId: null }),
    auditCase("space-over-128", { spaceId: "x".repeat(129) }),
    auditCase("metadata-mixed", {}, seedAudit({ metadata: "list" })),
    auditCase("metadata-not-an-object", {}, seedAudit({ metadata: "not-object" })),
    auditCase("odd-actor-and-outcome-are-coerced", {}, seedAudit({ odd: true })),
    auditCase("many-default-limit", {}, seedAudit({ many: 3 })),
    auditCase("anonymous", {}, undefined, { anonymous: true }),

    // vault.activity -------------------------------------------------------------------------
    va("account-item", { name: "travel-login" }, seedVaultActivity()),
    va("space-item-default-scope", { name: "travel-login" }, seedVaultActivity({ scope: "space", override: true })),
    va("space-item-wrong-default", { name: "travel-login" }, seedVaultActivity({ scope: "space" })),
    va("account-scope-explicit", { name: "travel-login", scope: "account" }, seedVaultActivity({ override: true })),
    va("space-scope-explicit", { name: "travel-login", scope: "space" }, seedVaultActivity({ scope: "space" })),
    va("space-scope-without-override", { name: "travel-login", scope: "space" }, seedVaultActivity({ override: true })),
    va("unknown-name", { name: "nope" }),
    va("no-item", { name: "travel-login" }, seedVaultActivity({ noItem: true })),
    va("duplicate-twin-merged", { name: "travel-login" }, seedVaultActivity({ twins: true })),
    va("limit-twenty", { name: "travel-login" }, seedVaultActivity({ many: 25 })),
    va("long-actor-fails-the-output-check", { name: "travel-login" }, seedVaultActivity({ longActor: true })),
    va("long-site-fails-the-output-check", { name: "travel-login" }, seedVaultActivity({ longSite: true })),
    va("missing-name", {}),
    va("null-name", { name: null }),
    va("empty-name", { name: "" }),
    va("long-name", { name: "x".repeat(257) }),
    va("bad-scope", { name: "travel-login", scope: "team" }),
    va("scope-number", { name: "travel-login", scope: 5 }),
    va("extra-key", { name: "travel-login", extra: true }),
    va("anonymous", { name: "travel-login" }, undefined, { anonymous: true }),

    // computer.dismissUpdate ----------------------------------------------------------------
    dismiss("failed", { id: "__s-du1__" }),
    dismiss("completed-is-a-no-op", { id: "__s-du2__" }),
    dismiss("unknown", { id: "nope" }),
    dismiss("another-space", { id: "__s-du3__" }),
    dismiss("only-archived-bots", { id: "__s-du4__" }),
    dismiss("missing-id", {}),
    dismiss("null-id", { id: null }),
    dismiss("empty-id", { id: "" }),
    dismiss("number-id", { id: 5 }),
    dismiss("array-id", { id: [1] }),
    dismiss("extra-key", { id: "__s-du1__", extra: true }),
    dismiss("anonymous", { id: "__s-du1__" }, undefined, { anonymous: true
    }),

    // computer.dismissDiskWarning ------------------------------------------------------------
    disk("percent-set", { botId: "__s-b1__" }),
    disk("never-measured", { botId: "__s-b2__" }),
    disk("zero-total", { botId: "__s-b3__" }),
    disk("archived-bot", { botId: "__s-b4__" }),
    disk("other-space-bot", { botId: "__s-bx__" }, seedDismiss(), { space: 1, input: { botId: "__s-bx__" } }),
    disk("another-space-from-space-one", { botId: "__s-bx__" }),
    disk("unknown-bot", { botId: "nope" }),
    disk("missing-bot-id", {}),
    disk("null-bot-id", { botId: null }),
    disk("empty-bot-id", { botId: "" }),
    disk("number-bot-id", { botId: 5 }),
    disk("extra-key", { botId: "__s-b1__", extra: true }),
    disk("anonymous", { botId: "__s-b1__" }, undefined, { anonymous: true }),

    // boards.list ----------------------------------------------------------------------------
    boards("boards.list", "bd-list", "lazy-create", undefined, seedBoard({ board: false })),
    boards("boards.list", "bd-list", "existing", undefined, seedBoard()),
    boards("boards.list", "bd-list", "lab-off", undefined, seedBoard({ lab: false })),
    boards("boards.list", "bd-list", "space-two", undefined, seedBoard({ board: false }), { space: 1 }),
    boards("boards.list", "bd-list", "junk-input-is-ignored", { anything: 1 }, seedBoard({ board: false })),
    boards("boards.list", "bd-list", "anonymous", undefined, undefined, { anonymous: true }),

    // boards.get -----------------------------------------------------------------------------
    boards("boards.get", "bd-get", "lazy-create", undefined, seedBoard({ board: false })),
    boards("boards.get", "bd-get", "existing", undefined, seedBoard()),
    boards("boards.get", "bd-get", "lab-off", undefined, seedBoard({ lab: false })),
    boards("boards.get", "bd-get", "space-two", undefined, seedBoard({ board: false }), { space: 1 }),
    boards("boards.get", "bd-get", "junk-input-is-ignored", { anything: 1 }, seedBoard({ board: false })),
    boards("boards.get", "bd-get", "anonymous", undefined, undefined, { anonymous: true }),

    // boards.rename --------------------------------------------------------------------------
    rename("name-only", { name: "Roadmap" }, seedBoard()),
    rename("prefix-only", { ticketPrefix: "ab" }, seedBoard()),
    rename("both", { name: "Roadmap", ticketPrefix: "ZZ" }, seedBoard()),
    rename("prefix-same-case-insensitive", { ticketPrefix: "rak" }, seedBoard()),
    rename("prefix-same-empty-data", { ticketPrefix: "RAK" }, seedBoard()),
    rename("name-and-same-prefix", { name: "Roadmap", ticketPrefix: "RAK" }, seedBoard()),
    rename("prefix-with-tickets", { ticketPrefix: "ZZ" }, seedBoard({ ticket: true })),
    rename("name-with-tickets", { name: "Roadmap" }, seedBoard({ ticket: true })),
    rename("lazy-create-then-rename", { name: "Roadmap" }, seedBoard({ board: false })),
    rename("lazy-create-prefix", { ticketPrefix: "ZZ" }, seedBoard({ board: false })),
    rename("space-two", { name: "Other" }, seedBoard({ board: false }), { space: 1 }),
    rename("lab-off", { name: "Nope" }, seedBoard({ lab: false })),
    rename("lab-off-bad-input", {}, seedBoard({ lab: false })),
    rename("empty-object", {}),
    rename("name-empty", { name: "   " }),
    rename("name-too-long", { name: "x".repeat(81) }),
    rename("name-null", { name: null }),
    rename("name-number", { name: 5 }),
    rename("prefix-empty", { ticketPrefix: "  " }),
    rename("prefix-too-long", { ticketPrefix: "A".repeat(13) }),
    rename("prefix-bad-start", { ticketPrefix: "1AB" }),
    rename("prefix-space", { ticketPrefix: "RA K" }),
    rename("prefix-null", { ticketPrefix: null }),
    rename("unknown-key-only", { other: 1 }),
    rename("array-input", []),
    rename("anonymous", { name: "X" }, undefined, { anonymous: true }),

    // Ticket DTO: mentionsMe must be absent from every ticket-returning procedure, exactly as
    // TypeScript's toTicketDto omits it (contract: optional). A mention-looking title/description
    // would have made the server-side flag true; the answer must still not carry the field.
    ticketDto("tickets.list", "tkd-list", "empty", {}, seedLabOnly),
    ticketDto("tickets.list", "tkd-list", "mention-looking-title", {}, seedTicketDto({ status: "review", title: "Blocked on @user for approval" })),
    ticketDto("tickets.get", "tkd-get", "mention-looking-title", { id: "__s-tkt__" }, seedTicketDto({ status: "review", title: "Blocked on @user for approval" })),
    ticketDto("tickets.get", "tkd-get", "missing", { id: "nope" }, seedTicketDto()),
    ticketDto("tickets.create", "tkd-create", "mention-looking-description", { title: "New task", description: "blocked on @user" }, seedLabOnly, { ignoreSignals: true }),
    ticketDto("tickets.update", "tkd-update", "mention-looking-title", { id: "__s-tkt__", title: "blocked on @user", status: "review" }, seedTicketDto()),
    ticketDto("tickets.move", "tkd-move", "mention-looking-title", { id: "__s-tkt__", status: "review" }, seedTicketDto({ status: "blocked", title: "Blocked on @user" })),
    ticketDto("tickets.comment", "tkd-comment", "mention-looking-title", { ticketId: "__s-tkt__", body: "still blocked on @user" }, seedTicketDto({ status: "review", title: "Blocked on @user" })),
  ];
}

/** The boards/computers rows lane H's cases change, plus the vault rows they seed. */
export async function laneHState(system: System, seeded: Seeded) {
  const boards = await system.board.findMany({
    where: { spaceId: { in: seeded.spaces } },
    select: { id: true, spaceId: true, name: true, ticketPrefix: true, nextNumber: true, createdAt: true, updatedAt: true },
    orderBy: { spaceId: "asc" },
  });
  const computers = await system.computer.findMany({
    where: { spaceId: { in: seeded.spaces } },
    select: { id: true, spaceId: true, diskDismissedPercent: true, updatedAt: true },
    orderBy: { id: "asc" },
  });
  const computerUpdates = await system.computerUpdate.findMany({
    where: { computerId: { startsWith: seeded.userId } },
    select: { id: true, computerId: true, botId: true, action: true, status: true, stage: true, updatedAt: true },
    orderBy: { id: "asc" },
  });
  return { laneHBoards: boards, laneHComputers: computers, laneHComputerUpdates: computerUpdates };
}
