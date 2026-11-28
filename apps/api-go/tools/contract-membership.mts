/**
 * Contract cases for the Space and organization procedures Go serves: spaces.rename,
 * spaces.members.list|add, spaces.invites.preview|accept|cancel, organizations.list|rename,
 * organizations.members.list and organizations.invitations.preview. They run beside the cases in
 * contract.mts (same seeding, same comparison of status, headers, body, database state, audit
 * rows and realtime signals); this file holds the cases, the extra fixture state they need and
 * the rows they compare.
 *
 * Ids in inputs: `__sp1__`..`__sp3__` the case's Spaces, `__org__` its organization,
 * `__s-<key>__` the user `<userId>-<key>`; `__sp1__-f` is the first Space of the foreign
 * organization `f` (see foreignOrg).
 */
import { createHash } from "node:crypto";
import type { Case, Seeded } from "./contract.mts";

type System = any;

const sha = (token: string) => createHash("sha256").update(token).digest("hex");
const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n));
// organizations.list and the invitation lists order by createdAt alone; organizations and
// invitations seeded together would otherwise share at(0)/at(20) or a default now(). One
// millisecond per seeded row, keyed by the seed object, keeps those orders total and identical on
// both sides (the harness seeds each side with a fresh object).
const seedTimes = new WeakMap<Seeded, number>();
const seedTime = (seeded: Seeded, base: Date) => {
  const n = seedTimes.get(seeded) ?? 0;
  seedTimes.set(seeded, n + 1);
  return new Date(base.getTime() + n);
};
const HOUR = 3_600_000;
/** Fixed instants, so both sides seed identical rows: a link or invitation that is still open, and one that has lapsed. */
const OPEN_UNTIL = new Date(Date.UTC(2099, 0, 1));
const LAPSED = new Date(Date.UTC(2020, 0, 1));
const expiry = (expiresIn: number | undefined) =>
  expiresIn !== undefined && expiresIn < 0 ? LAPSED : OPEN_UNTIL;
const FOREIGN_KEYS = ["f", "x", "y"] as const;

/** Every organization a case may create: its own and the foreign ones. */
const organizationsOf = (orgId: string) => [orgId, ...FOREIGN_KEYS.map((key) => `${orgId}-${key}`)];

export async function membershipReset(system: System, seeded: { userId: string; orgId: string }) {
  const { userId, orgId } = seeded;
  const prefix = userId.slice(0, -1);
  const organizations = organizationsOf(orgId);
  await system.spaceInvite.deleteMany({
    where: {
      OR: [{ createdByUserId: { startsWith: userId } }, { spaceId: { startsWith: prefix } }],
    },
  });
  await system.invitation.deleteMany({ where: { organizationId: { in: organizations } } });
  await system.spaceMember.deleteMany({ where: { organizationId: { in: organizations } } });
  await system.space.deleteMany({ where: { organizationId: { in: organizations } } });
  await system.member.deleteMany({ where: { organizationId: { in: organizations } } });
  await system.organization.deleteMany({ where: { id: { in: organizations.slice(1) } } });
  await system.user.deleteMany({ where: { id: { startsWith: `${userId}-` } } });
}

/** What the procedures change, as rows: no generated ids or times, which each side makes for itself. */
export async function membershipState(system: System, seeded: { userId: string; orgId: string }) {
  const organizations = organizationsOf(seeded.orgId);
  const prefix = seeded.userId.slice(0, -1);
  return {
    organizations: await system.organization.findMany({
      where: { id: { in: organizations } },
      select: { id: true, name: true },
      orderBy: { id: "asc" },
    }),
    spaces: await system.space.findMany({
      where: { organizationId: { in: organizations } },
      select: { id: true, organizationId: true, name: true, isDefault: true, deletingAt: true },
      orderBy: { id: "asc" },
    }),
    members: await system.member.findMany({
      where: { organizationId: { in: organizations } },
      select: { organizationId: true, userId: true, role: true },
      orderBy: [{ organizationId: "asc" }, { userId: "asc" }],
    }),
    spaceMembers: await system.spaceMember.findMany({
      where: { organizationId: { in: organizations } },
      select: { spaceId: true, organizationId: true, userId: true, role: true },
      orderBy: [{ spaceId: "asc" }, { userId: "asc" }],
    }),
    spaceInvites: (
      await system.spaceInvite.findMany({
        where: { spaceId: { startsWith: prefix } },
        select: {
          tokenHash: true,
          spaceId: true,
          createdByUserId: true,
          acceptedAt: true,
          acceptedByUserId: true,
        },
        orderBy: { tokenHash: "asc" },
      })
    ).map(({ acceptedAt, ...row }: { acceptedAt: Date | null }) => ({
      ...row,
      accepted: acceptedAt !== null,
    })),
    invitations: await system.invitation.findMany({
      where: { organizationId: { in: organizations } },
      select: {
        id: true,
        organizationId: true,
        email: true,
        role: true,
        status: true,
        inviterId: true,
      },
      orderBy: { id: "asc" },
    }),
  };
}

export function membershipCases(system: System): Case[] {
  const S = system;
  const idOf = (seeded: Seeded, key: string) => `${seeded.userId}-${key}`;
  const orgOf = (seeded: Seeded, key: string) => `${seeded.orgId}-${key}`;

  async function person(seeded: Seeded, key: string, data: Record<string, unknown> = {}) {
    await S.user.create({
      data: {
        id: idOf(seeded, key),
        name: `Person ${key}`,
        email: `${idOf(seeded, key)}@example.test`,
        emailVerified: true,
        ...data,
      },
    });
  }

  /** A member of an organization. Joining one with a default Space puts them in it, as the database trigger does. */
  async function orgMember(seeded: Seeded, orgId: string, key: string, role: string, n: number) {
    await S.member.create({
      data: {
        id: `${orgId}-m-${key}`,
        organizationId: orgId,
        userId: idOf(seeded, key),
        role,
        createdAt: at(n),
      },
    });
  }

  async function dropDefaultRow(orgId: string, key: string) {
    await S.spaceMember.deleteMany({ where: { id: `default-space-member:${orgId}-m-${key}` } });
  }

  async function inSpace(
    seeded: Seeded,
    spaceId: string,
    orgId: string,
    key: string,
    role: string,
    n: number,
  ) {
    await S.spaceMember.create({
      data: {
        id: `${spaceId}-sm-${key}`,
        spaceId,
        organizationId: orgId,
        userId: idOf(seeded, key),
        role,
        createdAt: at(n),
      },
    });
  }

  /** A member of org O and of Space `spaceId` only (not of the default Space). */
  async function spaceOnly(
    seeded: Seeded,
    spaceId: string,
    key: string,
    role: string,
    n: number,
    orgRole = "member",
  ) {
    await person(seeded, key);
    await orgMember(seeded, seeded.orgId, key, orgRole, n);
    await dropDefaultRow(seeded.orgId, key);
    await inSpace(seeded, spaceId, seeded.orgId, key, role, n);
  }

  /** Another organization, owned by `<key>o`, with a default and a second Space the caller is not in. */
  async function foreignOrg(seeded: Seeded, key: (typeof FOREIGN_KEYS)[number]) {
    const org = orgOf(seeded, key);
    const owner = `${key}o`;
    const d = `${seeded.spaces[0]}-${key}`;
    const s = `${seeded.spaces[1]}-${key}`;
    await person(seeded, owner);
    await S.organization.create({
      data: {
        id: org,
        name: `Org ${key}`,
        slug: `contract-${seeded.userId}-${key}`,
        createdAt: seedTime(seeded, at(0)),
      },
    });
    await S.member.create({
      data: {
        id: `${org}-m-${owner}`,
        organizationId: org,
        userId: idOf(seeded, owner),
        role: "owner",
        createdAt: at(0),
      },
    });
    await S.space.create({
      data: { id: d, organizationId: org, name: `Default ${key}`, isDefault: true },
    });
    await S.space.create({
      data: { id: s, organizationId: org, name: `Second ${key}`, isDefault: false },
    });
    for (const space of [d, s]) await inSpace(seeded, space, org, owner, "owner", 0);
    return { org, owner: idOf(seeded, owner), ownerKey: owner, d, s };
  }
  type Foreign = Awaited<ReturnType<typeof foreignOrg>>;

  /** The caller belongs to a Space of another organization only through that Space. */
  async function guestOf(seeded: Seeded, f: Foreign, space: "d" | "s", spaceRole = "member") {
    await S.member.create({
      data: {
        id: `${f.org}-m-u`,
        organizationId: f.org,
        userId: seeded.userId,
        role: "guest",
        createdAt: at(5),
      },
    });
    // The trigger put them in the default Space with the organization role.
    if (space === "d") {
      await S.spaceMember.updateMany({
        where: { id: `default-space-member:${f.org}-m-u` },
        data: { role: spaceRole },
      });
    } else {
      await S.spaceMember.deleteMany({ where: { id: `default-space-member:${f.org}-m-u` } });
      await S.spaceMember.create({
        data: {
          id: `${f.s}-sm-u`,
          spaceId: f.s,
          organizationId: f.org,
          userId: seeded.userId,
          role: spaceRole,
          createdAt: at(5),
        },
      });
    }
  }

  async function invite(
    seeded: Seeded,
    spaceId: string,
    token: string,
    options: { by?: string; expiresIn?: number; acceptedBy?: string } = {},
  ) {
    await S.spaceInvite.create({
      data: {
        id: `${seeded.userId}-inv-${token}`,
        spaceId,
        tokenHash: sha(token),
        createdByUserId: options.by ?? seeded.userId,
        createdAt: seedTime(seeded, at(0)),
        expiresAt: expiry(options.expiresIn),
        acceptedAt: options.acceptedBy ? at(10) : null,
        acceptedByUserId: options.acceptedBy ?? null,
      },
    });
  }

  async function orgInvite(
    seeded: Seeded,
    key: string,
    email: string,
    options: {
      status?: string;
      expiresIn?: number;
      by?: string;
      org?: string;
      id?: string;
      created?: number;
    } = {},
  ) {
    await S.invitation.create({
      data: {
        id: options.id ?? `${seeded.orgId}-inv-${key}`,
        organizationId: options.org ?? seeded.orgId,
        email,
        role: "member",
        status: options.status ?? "pending",
        expiresAt: expiry(options.expiresIn),
        createdAt:
          options.created === undefined ? seedTime(seeded, at(20)) : at(options.created),
        inviterId: options.by ?? seeded.userId,
      },
    });
  }

  const roleOf = async (seeded: Seeded, role: string) => {
    await S.member.update({
      where: { organizationId_userId: { organizationId: seeded.orgId, userId: seeded.userId } },
      data: { role },
    });
  };
  const spaceRoleOf = async (seeded: Seeded, spaceId: string, role: string) => {
    await S.spaceMember.updateMany({ where: { spaceId, userId: seeded.userId }, data: { role } });
  };

  const AFTER = [
    { procedure: "spaces.list", input: {} },
    { procedure: "organizations.list", input: {} },
  ];
  const readCase =
    (prefix: string, procedure: string) =>
    (name: string, input: unknown, extra: Partial<Case> = {}): Case => ({
      name: `${prefix}-${name}`,
      procedure,
      input,
      ...extra,
    });

  const cases: Case[] = [];

  // ---- spaces.rename ------------------------------------------------------------------------
  {
    const rename = readCase("sp-rename", "spaces.rename");
    const emoji = (count: number) => "😀".repeat(count);
    const notMember = async (seeded: Seeded) => {
      await foreignOrg(seeded, "f");
    };
    cases.push(
      rename(
        "ok",
        { spaceId: "__sp2__", name: "Renamed" },
        { after: [{ procedure: "spaces.members.list", input: { spaceId: "__sp2__" } }, ...AFTER] },
      ),
      rename("current-space", { spaceId: "__sp1__", name: "Home base" }),
      rename("from-another-active-space", { spaceId: "__sp1__", name: "Back home" }, { space: 2 }),
      rename("trims", { spaceId: "__sp2__", name: "  Padded name \t" }),
      rename("same-name", { spaceId: "__sp2__", name: "Space 2" }),
      rename("nul-in-name", { spaceId: "__sp2__", name: "a\u0000b" }),
      rename("lone-surrogate-in-name", { spaceId: "__sp2__", name: "a\ud800b" }),
      rename("emoji-and-letters-sixty-units", { spaceId: "__sp2__", name: `a${emoji(29)}b` }),
      rename("emoji-and-letters-sixty-one-units", { spaceId: "__sp2__", name: `a${emoji(30)}` }),
      rename("emoji-only-is-unreadable", { spaceId: "__sp2__", name: emoji(5) }),
      rename("emoji-too-many-for-zod", { spaceId: "__sp2__", name: `a${emoji(60)}` }),
      rename("sixty-characters", { spaceId: "__sp2__", name: "x".repeat(60) }),
      rename("sixty-one-characters", { spaceId: "__sp2__", name: "x".repeat(61) }),
      rename("unreadable-dashes", { spaceId: "__sp2__", name: "---" }),
      rename("unreadable-opaque-token", { spaceId: "__sp2__", name: "__token__" }),
      rename("unreadable-uuid", {
        spaceId: "__sp2__",
        name: "123e4567-e89b-12d3-a456-426614174000",
      }),
      rename("unreadable-cuid", { spaceId: "__sp2__", name: "ckjh2k3l4m5n6o7p8q9r0s1t2" }),
      rename("readable-with-digits", { spaceId: "__sp2__", name: "Q3 plans 2026" }),
      rename("empty-name", { spaceId: "__sp2__", name: "" }),
      rename("blank-name", { spaceId: "__sp2__", name: "   " }),
      rename("missing-name", { spaceId: "__sp2__" }),
      rename("missing-space", { name: "Named" }),
      rename("empty-space", { spaceId: "", name: "Named" }),
      rename("both-invalid", { spaceId: "", name: "" }),
      rename("wrong-types", { spaceId: 5, name: 7 }),
      rename("null-fields", { spaceId: null, name: null }),
      rename("array-fields", { spaceId: [], name: ["a"] }),
      rename("extra-keys-are-ignored", { spaceId: "__sp2__", name: "Extra", more: 1 }),
      rename("not-an-object", []),
      rename("null-input", null),
      rename("no-input", undefined),
      rename("unknown-space", { spaceId: "nowhere", name: "Named" }),
      rename("not-a-member", { spaceId: "__sp1__-f", name: "Named" }, { seed: notMember }),
      rename(
        "not-a-member-bad-name-answers-not-found",
        { spaceId: "__sp1__-f", name: "---" },
        { seed: notMember },
      ),
      rename("member-bad-name-answers-invalid", { spaceId: "__sp2__", name: "---" }),
      rename(
        "not-the-owner",
        { spaceId: "__sp2__", name: "Named" },
        { seed: (seeded) => spaceRoleOf(seeded, seeded.spaces[1], "member") },
      ),
      rename(
        "role-with-owner-in-a-list-is-not-owner",
        { spaceId: "__sp2__", name: "Named" },
        { seed: (seeded) => spaceRoleOf(seeded, seeded.spaces[1], "member,owner") },
      ),
      rename(
        "space-of-another-organization",
        { spaceId: "__sp2__-f", name: "Named" },
        {
          seed: async (seeded) => guestOf(seeded, await foreignOrg(seeded, "f"), "s", "owner"),
        },
      ),
      rename(
        "deleting",
        { spaceId: "__sp2__", name: "Named" },
        {
          seed: (seeded) =>
            S.space.update({ where: { id: seeded.spaces[1] }, data: { deletingAt: new Date() } }),
        },
      ),
      rename("anonymous", { spaceId: "__sp2__", name: "Named" }, { anonymous: true }),
    );
  }

  // ---- spaces.members.list ------------------------------------------------------------------
  {
    const list = readCase("sp-mlist", "spaces.members.list");
    /** The owner's Space: people of both kinds, a guest, someone to add, and links in every state. */
    const team = async (seeded: Seeded) => {
      await person(seeded, "m1", { image: "https://img.example/m1.png" });
      await orgMember(seeded, seeded.orgId, "m1", "member", 1);
      await inSpace(seeded, seeded.spaces[1], seeded.orgId, "m1", "member", 1);
      await person(seeded, "a1", { name: "Alice Admin" });
      await orgMember(seeded, seeded.orgId, "a1", "admin", 2);
      await inSpace(seeded, seeded.spaces[1], seeded.orgId, "a1", "owner", 2);
      await person(seeded, "co");
      await orgMember(seeded, seeded.orgId, "co", "member", 3);
      await inSpace(seeded, seeded.spaces[1], seeded.orgId, "co", " owner , x", 3);
      await spaceOnly(seeded, seeded.spaces[1], "g1", "member", 4, "guest");
      // In the organization but not in this Space: the owner can add them.
      await person(seeded, "m3");
      await orgMember(seeded, seeded.orgId, "m3", "member", 5);
      await dropDefaultRow(seeded.orgId, "m3");
      await person(seeded, "m4", { image: "https://img.example/m4.png" });
      await orgMember(seeded, seeded.orgId, "m4", "admin", 6);
      await dropDefaultRow(seeded.orgId, "m4");
      // A guest of the organization who is in no Space of it is not addable.
      await invite(seeded, seeded.spaces[1], "open-1");
      await invite(seeded, seeded.spaces[1], "open-2", { by: idOf(seeded, "m1") });
      await invite(seeded, seeded.spaces[1], "expired", { expiresIn: -HOUR });
      await invite(seeded, seeded.spaces[1], "used", { acceptedBy: idOf(seeded, "m1") });
      await invite(seeded, seeded.spaces[0], "other-space");
    };
    cases.push(
      list("owner-view", { spaceId: "__sp2__" }, { seed: team }),
      list("owner-view-current-space", { spaceId: "__sp1__" }, { seed: team }),
      list(
        "owner-view-from-another-active-space",
        { spaceId: "__sp2__" },
        { seed: team, space: 2 },
      ),
      list("alone", { spaceId: "__sp3__" }),
      list(
        "member-view",
        { spaceId: "__sp2__" },
        {
          seed: async (seeded) => {
            await team(seeded);
            await spaceRoleOf(seeded, seeded.spaces[1], "member");
          },
        },
      ),
      list(
        "owner-who-is-a-guest-of-the-organization",
        { spaceId: "__sp2__-f" },
        {
          seed: async (seeded) => {
            const f = await foreignOrg(seeded, "f");
            await guestOf(seeded, f, "s", "owner");
            await person(seeded, "fm");
            await orgMember(seeded, f.org, "fm", "member", 2);
            await dropDefaultRow(f.org, "fm");
            await invite(seeded, f.s, "foreign-open", { by: f.owner });
          },
        },
      ),
      list(
        "guest-member-view",
        { spaceId: "__sp2__-f" },
        { seed: async (seeded) => guestOf(seeded, await foreignOrg(seeded, "f"), "s") },
      ),
      list(
        "space-being-deleted",
        { spaceId: "__sp2__" },
        {
          seed: async (seeded) => {
            await team(seeded);
            await S.space.update({
              where: { id: seeded.spaces[1] },
              data: { deletingAt: new Date() },
            });
          },
        },
      ),
      list(
        "not-a-member",
        { spaceId: "__sp1__-f" },
        { seed: async (seeded) => void (await foreignOrg(seeded, "f")) },
      ),
      list("unknown-space", { spaceId: "nowhere" }),
      list("empty-space", { spaceId: "" }),
      list("missing-space", {}),
      list("wrong-type", { spaceId: 5 }),
      list("null-space", { spaceId: null }),
      list("extra-keys-are-ignored", { spaceId: "__sp2__", more: 1 }),
      list("not-an-object", []),
      list("null-input", null),
      list("no-input", undefined),
      list("anonymous", { spaceId: "__sp2__" }, { anonymous: true }),
    );
  }

  // ---- spaces.members.add -------------------------------------------------------------------
  {
    const add = readCase("sp-madd", "spaces.members.add");
    const AFTER_ADD = [
      { procedure: "spaces.members.list", input: { spaceId: "__sp2__" } },
      ...AFTER,
    ];
    const colleague = async (seeded: Seeded, key = "m1", role = "member") => {
      await person(seeded, key);
      await orgMember(seeded, seeded.orgId, key, role, 1);
      await dropDefaultRow(seeded.orgId, key);
    };
    cases.push(
      add(
        "ok",
        { spaceId: "__sp2__", userId: "__s-m1__" },
        { seed: (seeded) => colleague(seeded), after: AFTER_ADD },
      ),
      add(
        "admin-colleague",
        { spaceId: "__sp2__", userId: "__s-m1__" },
        { seed: (seeded) => colleague(seeded, "m1", "admin") },
      ),
      add(
        "from-another-active-space",
        { spaceId: "__sp2__", userId: "__s-m1__" },
        { seed: (seeded) => colleague(seeded), space: 2 },
      ),
      add(
        "into-the-current-space",
        { spaceId: "__sp1__", userId: "__s-m1__" },
        { seed: (seeded) => colleague(seeded) },
      ),
      add(
        "already-in-the-space",
        { spaceId: "__sp2__", userId: "__s-m1__" },
        {
          seed: async (seeded) => {
            await colleague(seeded);
            await inSpace(seeded, seeded.spaces[1], seeded.orgId, "m1", "member", 1);
          },
          after: AFTER_ADD,
        },
      ),
      add("themselves", { spaceId: "__sp2__", userId: "__user__" }),
      add(
        "not-in-the-organization",
        { spaceId: "__sp2__", userId: "__s-stranger__" },
        { seed: (seeded) => person(seeded, "stranger") },
      ),
      add(
        "guest-of-the-organization",
        { spaceId: "__sp2__", userId: "__s-m1__" },
        { seed: (seeded) => colleague(seeded, "m1", "guest") },
      ),
      add("unknown-user", { spaceId: "__sp2__", userId: "nobody" }),
      add("nul-in-user-id", { spaceId: "__sp2__", userId: "a\u0000b" }),
      add("lone-surrogate-in-user-id", { spaceId: "__sp2__", userId: "a\ud800b" }),
      add(
        "caller-is-not-an-owner",
        { spaceId: "__sp2__", userId: "__s-m1__" },
        {
          seed: async (seeded) => {
            await colleague(seeded);
            await spaceRoleOf(seeded, seeded.spaces[1], "member");
          },
        },
      ),
      add(
        "caller-is-a-guest-of-the-organization",
        { spaceId: "__sp2__-f", userId: "__s-fm__" },
        {
          seed: async (seeded) => {
            const f = await foreignOrg(seeded, "f");
            await guestOf(seeded, f, "s", "owner");
            await person(seeded, "fm");
            await orgMember(seeded, f.org, "fm", "member", 2);
            await dropDefaultRow(f.org, "fm");
          },
        },
      ),
      add(
        "space-of-another-organization",
        { spaceId: "__sp2__-f", userId: "__s-m1__" },
        {
          seed: async (seeded) => {
            await guestOf(seeded, await foreignOrg(seeded, "f"), "s", "owner");
            await colleague(seeded);
          },
        },
      ),
      add(
        "not-a-member-of-the-space",
        { spaceId: "__sp1__-f", userId: "__s-m1__" },
        {
          seed: async (seeded) => {
            await foreignOrg(seeded, "f");
            await colleague(seeded);
          },
        },
      ),
      add(
        "space-being-deleted",
        { spaceId: "__sp2__", userId: "__s-m1__" },
        {
          seed: async (seeded) => {
            await colleague(seeded);
            await S.space.update({
              where: { id: seeded.spaces[1] },
              data: { deletingAt: new Date() },
            });
          },
        },
      ),
      add(
        "at-the-space-limit",
        { spaceId: "__sp2__", userId: "__s-m1__" },
        {
          seed: async (seeded) => {
            await colleague(seeded);
            // One in the default Space's row is gone; 32 Spaces fill the limit.
            for (let index = 0; index < 32; index += 1) {
              const id = `${seeded.userId.slice(0, -1)}-fill${String(index).padStart(2, "0")}`;
              await S.space.create({
                data: { id, organizationId: seeded.orgId, name: `Fill ${index}`, isDefault: false },
              });
              await inSpace(seeded, id, seeded.orgId, "m1", "member", 1);
            }
          },
        },
      ),
      add(
        "one-below-the-space-limit",
        { spaceId: "__sp2__", userId: "__s-m1__" },
        {
          seed: async (seeded) => {
            await colleague(seeded);
            for (let index = 0; index < 31; index += 1) {
              const id = `${seeded.userId.slice(0, -1)}-fill${String(index).padStart(2, "0")}`;
              await S.space.create({
                data: { id, organizationId: seeded.orgId, name: `Fill ${index}`, isDefault: false },
              });
              await inSpace(seeded, id, seeded.orgId, "m1", "member", 1);
            }
          },
        },
      ),
      add("empty-user", { spaceId: "__sp2__", userId: "" }),
      add("empty-space", { spaceId: "", userId: "__s-m1__" }),
      add("both-empty", { spaceId: "", userId: "" }),
      add("missing-user", { spaceId: "__sp2__" }),
      add("missing-space", { userId: "__s-m1__" }),
      add("wrong-types", { spaceId: 1, userId: [] }),
      add(
        "extra-keys-are-ignored",
        { spaceId: "__sp2__", userId: "__s-m1__", more: 1 },
        { seed: (seeded) => colleague(seeded) },
      ),
      add("not-an-object", []),
      add("null-input", null),
      add("no-input", undefined),
      add(
        "anonymous",
        { spaceId: "__sp2__", userId: "__s-m1__" },
        { seed: (seeded) => colleague(seeded), anonymous: true },
      ),
    );
  }

  // ---- spaces.invites.preview ---------------------------------------------------------------
  {
    const preview = readCase("sp-iprev", "spaces.invites.preview");
    const foreignInvite = async (
      seeded: Seeded,
      options: Parameters<typeof invite>[3] = {},
      token = "tok-open",
    ) => {
      const f = await foreignOrg(seeded, "f");
      await invite(seeded, f.s, token, { by: f.owner, ...options });
      return f;
    };
    cases.push(
      preview(
        "open-link-from-outside",
        { token: "tok-open" },
        { seed: (seeded) => foreignInvite(seeded).then(() => undefined) },
      ),
      preview(
        "open-link-to-the-default-space",
        { token: "tok-open" },
        {
          seed: async (seeded) => {
            const f = await foreignOrg(seeded, "f");
            await invite(seeded, f.d, "tok-open", { by: f.owner });
          },
        },
      ),
      preview(
        "already-a-member",
        { token: "tok-open" },
        { seed: (seeded) => invite(seeded, seeded.spaces[1], "tok-open") },
      ),
      preview(
        "used-by-the-caller-who-still-belongs",
        { token: "tok-open" },
        {
          seed: (seeded) =>
            invite(seeded, seeded.spaces[1], "tok-open", { acceptedBy: seeded.userId }),
        },
      ),
      preview(
        "used-by-the-caller-who-left",
        { token: "tok-open" },
        {
          seed: async (seeded) => {
            const f = await foreignOrg(seeded, "f");
            await invite(seeded, f.s, "tok-open", { by: f.owner, acceptedBy: seeded.userId });
          },
        },
      ),
      preview(
        "used-by-someone-else",
        { token: "tok-open" },
        {
          seed: async (seeded) => {
            await person(seeded, "m1");
            await invite(seeded, seeded.spaces[1], "tok-open", { acceptedBy: idOf(seeded, "m1") });
          },
        },
      ),
      preview(
        "used-by-someone-else-in-another-organization",
        { token: "tok-open" },
        {
          seed: async (seeded) => {
            const f = await foreignOrg(seeded, "f");
            await invite(seeded, f.s, "tok-open", { by: f.owner, acceptedBy: f.owner });
          },
        },
      ),
      preview(
        "expired",
        { token: "tok-open" },
        { seed: (seeded) => foreignInvite(seeded, { expiresIn: -HOUR }).then(() => undefined) },
      ),
      preview(
        "space-being-deleted",
        { token: "tok-open" },
        {
          seed: async (seeded) => {
            const f = await foreignInvite(seeded);
            await S.space.update({ where: { id: f.s }, data: { deletingAt: new Date() } });
          },
        },
      ),
      preview("unknown-token", { token: "tok-nobody" }),
      preview(
        "wrong-case-token-is-unknown",
        { token: "TOK-OPEN" },
        { seed: (seeded) => foreignInvite(seeded).then(() => undefined) },
      ),
      preview("nul-in-token", { token: "a\u0000b" }),
      preview("lone-surrogate-in-token", { token: "a\ud800b" }),
      preview("two-hundred-characters", { token: "t".repeat(200) }),
      preview("two-hundred-and-one-characters", { token: "t".repeat(201) }),
      preview("empty-token", { token: "" }),
      preview("missing-token", {}),
      preview("wrong-type", { token: 5 }),
      preview("array-token", { token: ["tok-open"] }),
      preview("null-token", { token: null }),
      preview("extra-keys-are-ignored", { token: "tok-nobody", more: 1 }),
      preview("not-an-object", []),
      preview("null-input", null),
      preview("no-input", undefined),
      preview(
        "anonymous",
        { token: "tok-open" },
        { seed: (seeded) => foreignInvite(seeded).then(() => undefined), anonymous: true },
      ),
    );
  }

  // ---- spaces.invites.accept ----------------------------------------------------------------
  {
    const accept = readCase("sp-iacc", "spaces.invites.accept");
    const AFTER_ACCEPT = [
      { procedure: "spaces.invites.preview", input: { token: "tok-open" } },
      { procedure: "spaces.members.list", input: { spaceId: "__sp2__-f" } },
      ...AFTER,
    ];
    const foreignInvite = async (
      seeded: Seeded,
      space: "d" | "s",
      options: Parameters<typeof invite>[3] = {},
    ) => {
      const f = await foreignOrg(seeded, "f");
      await invite(seeded, f[space], "tok-open", { by: f.owner, ...options });
      return f;
    };
    cases.push(
      accept(
        "guest-of-another-organization",
        { token: "tok-open" },
        { seed: (seeded) => foreignInvite(seeded, "s").then(() => undefined), after: AFTER_ACCEPT },
      ),
      accept(
        "guest-into-the-default-space",
        { token: "tok-open" },
        { seed: (seeded) => foreignInvite(seeded, "d").then(() => undefined), after: AFTER_ACCEPT },
      ),
      accept(
        "existing-guest-of-the-organization",
        { token: "tok-open" },
        {
          seed: async (seeded) => {
            const f = await foreignInvite(seeded, "s");
            await S.member.create({
              data: {
                id: `${f.org}-m-u`,
                organizationId: f.org,
                userId: seeded.userId,
                role: "guest",
                createdAt: at(5),
              },
            });
            // Already a guest of the default Space only.
            await S.spaceMember.updateMany({
              where: { id: `default-space-member:${f.org}-m-u` },
              data: { role: "member" },
            });
          },
          after: AFTER_ACCEPT,
        },
      ),
      accept(
        "full-member-of-the-organization",
        { token: "tok-open" },
        {
          seed: async (seeded) => {
            const f = await foreignInvite(seeded, "s");
            await S.member.create({
              data: {
                id: `${f.org}-m-u`,
                organizationId: f.org,
                userId: seeded.userId,
                role: "member",
                createdAt: at(5),
              },
            });
            await S.spaceMember.deleteMany({ where: { id: `default-space-member:${f.org}-m-u` } });
          },
          after: AFTER_ACCEPT,
        },
      ),
      accept(
        "from-another-active-space",
        { token: "tok-open" },
        { seed: (seeded) => foreignInvite(seeded, "s").then(() => undefined), space: 1 },
      ),
      accept(
        "already-a-member-leaves-the-link-unused",
        { token: "tok-open" },
        {
          seed: (seeded) => invite(seeded, seeded.spaces[1], "tok-open"),
          after: AFTER_ACCEPT,
        },
      ),
      accept(
        "used-by-the-caller-who-still-belongs",
        { token: "tok-open" },
        {
          seed: (seeded) =>
            invite(seeded, seeded.spaces[1], "tok-open", { acceptedBy: seeded.userId }),
        },
      ),
      accept(
        "used-by-someone-else",
        { token: "tok-open" },
        {
          seed: async (seeded) => {
            const f = await foreignOrg(seeded, "f");
            await invite(seeded, f.s, "tok-open", { by: f.owner, acceptedBy: f.owner });
          },
        },
      ),
      accept(
        "expired",
        { token: "tok-open" },
        {
          seed: (seeded) => foreignInvite(seeded, "s", { expiresIn: -HOUR }).then(() => undefined),
        },
      ),
      accept(
        "space-being-deleted",
        { token: "tok-open" },
        {
          seed: async (seeded) => {
            const f = await foreignInvite(seeded, "s");
            await S.space.update({ where: { id: f.s }, data: { deletingAt: new Date() } });
          },
        },
      ),
      accept("unknown-token", { token: "tok-nobody" }),
      accept("two-hundred-characters", { token: "t".repeat(200) }),
      accept("two-hundred-and-one-characters", { token: "t".repeat(201) }),
      accept("empty-token", { token: "" }),
      accept("missing-token", {}),
      accept("wrong-type", { token: 5 }),
      accept(
        "extra-keys-are-ignored",
        { token: "tok-open", more: 1 },
        { seed: (seeded) => foreignInvite(seeded, "s").then(() => undefined) },
      ),
      accept("not-an-object", []),
      accept("null-input", null),
      accept("no-input", undefined),
      accept(
        "anonymous",
        { token: "tok-open" },
        { seed: (seeded) => foreignInvite(seeded, "s").then(() => undefined), anonymous: true },
      ),
    );
  }

  // ---- spaces.invites.cancel ----------------------------------------------------------------
  {
    const cancel = readCase("sp-icancel", "spaces.invites.cancel");
    const links = async (seeded: Seeded) => {
      await person(seeded, "m1");
      await invite(seeded, seeded.spaces[1], "open-1");
      await invite(seeded, seeded.spaces[1], "open-2", { by: idOf(seeded, "m1") });
      await invite(seeded, seeded.spaces[1], "expired", { expiresIn: -HOUR });
      await invite(seeded, seeded.spaces[1], "used", { acceptedBy: idOf(seeded, "m1") });
      await invite(seeded, seeded.spaces[0], "other-space");
    };
    cases.push(
      cancel(
        "ok",
        { spaceId: "__sp2__" },
        {
          seed: links,
          after: [{ procedure: "spaces.members.list", input: { spaceId: "__sp2__" } }],
        },
      ),
      cancel("no-links", { spaceId: "__sp2__" }),
      cancel("from-another-active-space", { spaceId: "__sp2__" }, { seed: links, space: 2 }),
      cancel(
        "not-the-owner",
        { spaceId: "__sp2__" },
        {
          seed: async (seeded) => {
            await links(seeded);
            await spaceRoleOf(seeded, seeded.spaces[1], "member");
          },
        },
      ),
      cancel(
        "space-being-deleted",
        { spaceId: "__sp2__" },
        {
          seed: async (seeded) => {
            await links(seeded);
            await S.space.update({
              where: { id: seeded.spaces[1] },
              data: { deletingAt: new Date() },
            });
          },
        },
      ),
      cancel(
        "not-a-member",
        { spaceId: "__sp1__-f" },
        { seed: async (seeded) => void (await foreignOrg(seeded, "f")) },
      ),
      cancel("unknown-space", { spaceId: "nowhere" }),
      cancel("empty-space", { spaceId: "" }),
      cancel("missing-space", {}),
      cancel("wrong-type", { spaceId: 5 }),
      cancel("extra-keys-are-ignored", { spaceId: "__sp2__", more: 1 }, { seed: links }),
      cancel("not-an-object", []),
      cancel("null-input", null),
      cancel("no-input", undefined),
      cancel("anonymous", { spaceId: "__sp2__" }, { seed: links, anonymous: true }),
    );
  }

  // ---- organizations.list -------------------------------------------------------------------
  {
    const list = readCase("og-list", "organizations.list");
    const several = async (seeded: Seeded) => {
      // A second organization the caller owns, and one they administer, each with Spaces of their own.
      const x = await foreignOrg(seeded, "x");
      await S.member.create({
        data: {
          id: `${x.org}-m-u`,
          organizationId: x.org,
          userId: seeded.userId,
          role: "owner",
          createdAt: at(8),
        },
      });
      await S.member.update({
        where: { id: `${x.org}-m-${x.ownerKey}` },
        data: { role: "member" },
      });
      const y = await foreignOrg(seeded, "y");
      await S.member.create({
        data: {
          id: `${y.org}-m-u`,
          organizationId: y.org,
          userId: seeded.userId,
          role: "admin",
          createdAt: at(9),
        },
      });
      // Spaces shared with them as a guest from an organization they are not a member of.
      const f = await foreignOrg(seeded, "f");
      await guestOf(seeded, f, "s");
      await person(seeded, "m1");
      await orgMember(seeded, seeded.orgId, "m1", "member", 1);
    };
    cases.push(
      list("single-organization", {}),
      list("no-input", undefined),
      list("null-input", null),
      list("extra-keys-are-ignored", { more: 1 }),
      list("several-organizations", {}, { seed: several }),
      list("several-from-another-active-space", {}, { seed: several, space: 2 }),
      list(
        "active-space-is-a-guest-space",
        {},
        {
          seed: async (seeded) => {
            const f = await foreignOrg(seeded, "f");
            // Their third Space now belongs to the other organization, where they are a guest.
            await S.spaceMember.deleteMany({ where: { spaceId: seeded.spaces[2] } });
            await S.space.update({
              where: { id: seeded.spaces[2] },
              data: { organizationId: f.org },
            });
            await S.member.create({
              data: {
                id: `${f.org}-m-u`,
                organizationId: f.org,
                userId: seeded.userId,
                role: "guest",
                createdAt: at(5),
              },
            });
            await S.spaceMember.deleteMany({ where: { id: `default-space-member:${f.org}-m-u` } });
            await S.spaceMember.create({
              data: {
                id: `${seeded.spaces[2]}-sm-u`,
                spaceId: seeded.spaces[2],
                organizationId: f.org,
                userId: seeded.userId,
                role: "member",
                createdAt: at(5),
              },
            });
          },
          space: 2,
        },
      ),
      list(
        "default-space-they-are-not-in",
        {},
        {
          seed: async (seeded) => {
            const x = await foreignOrg(seeded, "x");
            await S.member.create({
              data: {
                id: `${x.org}-m-u`,
                organizationId: x.org,
                userId: seeded.userId,
                role: "member",
                createdAt: at(8),
              },
            });
            await S.spaceMember.deleteMany({ where: { id: `default-space-member:${x.org}-m-u` } });
            await S.spaceMember.create({
              data: {
                id: `${x.s}-sm-u`,
                spaceId: x.s,
                organizationId: x.org,
                userId: seeded.userId,
                role: "owner",
                createdAt: at(8),
              },
            });
          },
        },
      ),
      list(
        "only-a-member-space-in-it",
        {},
        {
          seed: async (seeded) => {
            const x = await foreignOrg(seeded, "x");
            await S.member.create({
              data: {
                id: `${x.org}-m-u`,
                organizationId: x.org,
                userId: seeded.userId,
                role: "member",
                createdAt: at(8),
              },
            });
            await S.spaceMember.deleteMany({ where: { id: `default-space-member:${x.org}-m-u` } });
            await S.spaceMember.create({
              data: {
                id: `${x.s}-sm-u`,
                spaceId: x.s,
                organizationId: x.org,
                userId: seeded.userId,
                role: "member",
                createdAt: at(8),
              },
            });
          },
        },
      ),
      list(
        "in-no-space-of-it",
        {},
        {
          seed: async (seeded) => {
            const x = await foreignOrg(seeded, "x");
            await S.member.create({
              data: {
                id: `${x.org}-m-u`,
                organizationId: x.org,
                userId: seeded.userId,
                role: "member",
                createdAt: at(8),
              },
            });
            await S.spaceMember.deleteMany({ where: { id: `default-space-member:${x.org}-m-u` } });
          },
        },
      ),
      list(
        "spaces-being-deleted-are-left-out",
        {},
        {
          seed: async (seeded) => {
            await S.space.update({
              where: { id: seeded.spaces[2] },
              data: { deletingAt: new Date() },
            });
          },
        },
      ),
      list(
        "organization-being-deleted-is-left-out",
        {},
        {
          seed: async (seeded) => {
            const x = await foreignOrg(seeded, "x");
            await S.member.create({
              data: {
                id: `${x.org}-m-u`,
                organizationId: x.org,
                userId: seeded.userId,
                role: "owner",
                createdAt: at(8),
              },
            });
            await S.space.update({ where: { id: x.d }, data: { deletingAt: new Date() } });
          },
        },
      ),
      list(
        "roles-in-a-list",
        {},
        {
          seed: async (seeded) => {
            await roleOf(seeded, "member, admin");
            const x = await foreignOrg(seeded, "x");
            await S.member.create({
              data: {
                id: `${x.org}-m-u`,
                organizationId: x.org,
                userId: seeded.userId,
                role: " owner,admin",
                createdAt: at(8),
              },
            });
          },
        },
      ),
      list(
        "many-members-counted-without-guests",
        {},
        {
          seed: async (seeded) => {
            for (const [key, role] of [
              ["m1", "member"],
              ["m2", "admin"],
              ["g1", "guest"],
              ["g2", "guest"],
            ] as const) {
              await person(seeded, key);
              await orgMember(seeded, seeded.orgId, key, role, 1);
            }
          },
        },
      ),
      list("anonymous", {}, { anonymous: true }),
    );
  }

  // ---- organizations.rename -----------------------------------------------------------------
  {
    const rename = readCase("og-rename", "organizations.rename");
    const emoji = (count: number) => "😀".repeat(count);
    cases.push(
      rename(
        "ok",
        { organizationId: "__org__", name: "Renamed org" },
        { after: [{ procedure: "organizations.list", input: {} }] },
      ),
      rename(
        "from-another-active-space",
        { organizationId: "__org__", name: "Renamed org" },
        { space: 2 },
      ),
      rename("trims", { organizationId: "__org__", name: "  Padded  " }),
      rename("nul-in-name", { organizationId: "__org__", name: "a\u0000b" }),
      rename("lone-surrogate-in-name", { organizationId: "__org__", name: "a\ud800b" }),
      rename("emoji-and-letters-sixty-units", {
        organizationId: "__org__",
        name: `a${emoji(29)}b`,
      }),
      rename("emoji-and-letters-sixty-one-units", {
        organizationId: "__org__",
        name: `a${emoji(30)}`,
      }),
      rename("emoji-only-is-unreadable", { organizationId: "__org__", name: emoji(5) }),
      rename("sixty-one-characters", { organizationId: "__org__", name: "x".repeat(61) }),
      rename("unreadable-dashes", { organizationId: "__org__", name: "---" }),
      rename("unreadable-opaque-token", { organizationId: "__org__", name: "__token__" }),
      rename("empty-name", { organizationId: "__org__", name: "" }),
      rename("blank-name", { organizationId: "__org__", name: "   " }),
      rename("missing-name", { organizationId: "__org__" }),
      rename("missing-organization", { name: "Named" }),
      rename("empty-organization", { organizationId: "", name: "Named" }),
      rename("both-invalid", { organizationId: "", name: "" }),
      rename("wrong-types", { organizationId: 5, name: 7 }),
      rename("extra-keys-are-ignored", { organizationId: "__org__", name: "Extra", more: 1 }),
      rename("not-an-object", []),
      rename("null-input", null),
      rename("no-input", undefined),
      rename("unknown-organization", { organizationId: "nowhere", name: "Named" }),
      rename("unknown-organization-bad-name-answers-invalid", {
        organizationId: "nowhere",
        name: "---",
      }),
      rename(
        "another-organization-they-own",
        { organizationId: "__org__-x", name: "Renamed x" },
        {
          seed: async (seeded) => {
            const x = await foreignOrg(seeded, "x");
            await S.member.create({
              data: {
                id: `${x.org}-m-u`,
                organizationId: x.org,
                userId: seeded.userId,
                role: "owner",
                createdAt: at(8),
              },
            });
          },
        },
      ),
      rename(
        "not-a-member",
        { organizationId: "__org__-f", name: "Named" },
        { seed: async (seeded) => void (await foreignOrg(seeded, "f")) },
      ),
      rename(
        "admin-is-not-the-owner",
        { organizationId: "__org__", name: "Named" },
        { seed: (seeded) => roleOf(seeded, "admin") },
      ),
      rename(
        "member-is-not-the-owner",
        { organizationId: "__org__", name: "Named" },
        { seed: (seeded) => roleOf(seeded, "member") },
      ),
      rename(
        "guest-is-not-the-owner",
        { organizationId: "__org__", name: "Named" },
        { seed: (seeded) => roleOf(seeded, "guest") },
      ),
      rename(
        "role-that-contains-owner",
        { organizationId: "__org__", name: "Named" },
        { seed: (seeded) => roleOf(seeded, "co-owner") },
      ),
      rename(
        "owner-in-a-list",
        { organizationId: "__org__", name: "Named" },
        { seed: (seeded) => roleOf(seeded, "admin,owner") },
      ),
      rename(
        "organization-being-deleted",
        { organizationId: "__org__", name: "Named" },
        {
          seed: (seeded) =>
            S.space.update({ where: { id: seeded.spaces[0] }, data: { deletingAt: new Date() } }),
          space: 1,
        },
      ),
      rename("anonymous", { organizationId: "__org__", name: "Named" }, { anonymous: true }),
    );
  }

  // ---- organizations.members.list -----------------------------------------------------------
  {
    const list = readCase("og-mlist", "organizations.members.list");
    /** Every kind of member and invitation: what a manager sees in full. */
    const everyone = async (seeded: Seeded) => {
      await person(seeded, "ad", { name: "Alice Admin", image: "https://img.example/ad.png" });
      await orgMember(seeded, seeded.orgId, "ad", "admin", 1);
      await person(seeded, "m1");
      await orgMember(seeded, seeded.orgId, "m1", "member", 2);
      await person(seeded, "m2", { name: "Zed" });
      await orgMember(seeded, seeded.orgId, "m2", "member", 3);
      await person(seeded, "ma");
      await orgMember(seeded, seeded.orgId, "ma", "admin,member", 4);
      await person(seeded, "o2");
      await orgMember(seeded, seeded.orgId, "o2", "member,owner", 5);
      // A guest in one Space is not listed; a guest who owns a Space is a removal that stopped part way.
      await spaceOnly(seeded, seeded.spaces[1], "g1", "member", 6, "guest");
      await spaceOnly(seeded, seeded.spaces[2], "g2", "owner", 7, "guest");
      await orgInvite(seeded, "ok", "newcomer@example.test");
      await orgInvite(seeded, "second", "second@example.test", {
        created: 21,
        id: `${seeded.orgId}-inv-with space and é^{}`,
      });
      await orgInvite(seeded, "dots", "dots@example.test", {
        created: 23,
        id: `${seeded.orgId}-inv-a/../b`,
      });
      await orgInvite(seeded, "query", "query@example.test", {
        created: 24,
        id: `${seeded.orgId}-inv-q?x#y`,
      });
      await orgInvite(seeded, "backslash", "slash@example.test", {
        created: 25,
        id: `${seeded.orgId}-inv-c\\d\te`,
      });
      await orgInvite(seeded, "expired", "late@example.test", { expiresIn: -HOUR });
      await orgInvite(seeded, "canceled", "gone@example.test", { status: "canceled" });
      await orgInvite(seeded, "accepted", "joined@example.test", { status: "accepted" });
      await orgInvite(seeded, "by-another", "other@example.test", {
        by: idOf(seeded, "ad"),
        created: 22,
      });
    };
    cases.push(
      list("owner-view", { organizationId: "__org__" }, { seed: everyone }),
      list(
        "owner-view-from-another-active-space",
        { organizationId: "__org__" },
        { seed: everyone, space: 2 },
      ),
      list("alone", { organizationId: "__org__" }),
      list(
        "admin-view",
        { organizationId: "__org__" },
        {
          seed: async (seeded) => {
            await everyone(seeded);
            await roleOf(seeded, "admin");
          },
        },
      ),
      list(
        "member-view-has-no-invitations",
        { organizationId: "__org__" },
        {
          seed: async (seeded) => {
            await everyone(seeded);
            await roleOf(seeded, "member");
          },
        },
      ),
      list(
        "guest-view",
        { organizationId: "__org__" },
        {
          seed: async (seeded) => {
            await everyone(seeded);
            await roleOf(seeded, "guest");
          },
        },
      ),
      list(
        "another-organization-they-own",
        { organizationId: "__org__-x" },
        {
          seed: async (seeded) => {
            const x = await foreignOrg(seeded, "x");
            await S.member.create({
              data: {
                id: `${x.org}-m-u`,
                organizationId: x.org,
                userId: seeded.userId,
                role: "owner",
                createdAt: at(8),
              },
            });
            await orgInvite(seeded, "x1", "x@example.test", { org: x.org, id: `${x.org}-inv-1` });
          },
        },
      ),
      list(
        "not-a-member",
        { organizationId: "__org__-f" },
        { seed: async (seeded) => void (await foreignOrg(seeded, "f")) },
      ),
      list(
        "organization-being-deleted",
        { organizationId: "__org__" },
        {
          seed: async (seeded) => {
            await everyone(seeded);
            await S.space.update({
              where: { id: seeded.spaces[0] },
              data: { deletingAt: new Date() },
            });
          },
          space: 1,
        },
      ),
      list("unknown-organization", { organizationId: "nowhere" }),
      list("empty-organization", { organizationId: "" }),
      list("missing-organization", {}),
      list("wrong-type", { organizationId: 5 }),
      list("extra-keys-are-ignored", { organizationId: "__org__", more: 1 }, { seed: everyone }),
      list("not-an-object", []),
      list("null-input", null),
      list("no-input", undefined),
      list("anonymous", { organizationId: "__org__" }, { seed: everyone, anonymous: true }),
    );
  }

  // ---- organizations.invitations.preview ----------------------------------------------------
  {
    const preview = readCase("og-iprev", "organizations.invitations.preview");
    const mine = (seeded: Seeded) => `${seeded.userId}@example.test`;
    const unverified = (seeded: Seeded) =>
      S.user.update({ where: { id: seeded.userId }, data: { emailVerified: false } });
    cases.push(
      preview(
        "ok",
        { invitationId: "__org__-inv-ok" },
        { seed: (seeded) => orgInvite(seeded, "ok", mine(seeded)) },
      ),
      preview(
        "inviter-is-another-person",
        { invitationId: "__org__-inv-ok" },
        {
          seed: async (seeded) => {
            await person(seeded, "ad", { name: "Alice Admin" });
            await orgMember(seeded, seeded.orgId, "ad", "admin", 1);
            await orgInvite(seeded, "ok", mine(seeded), { by: idOf(seeded, "ad") });
          },
        },
      ),
      preview(
        "from-another-active-space",
        { invitationId: "__org__-inv-ok" },
        { seed: (seeded) => orgInvite(seeded, "ok", mine(seeded)), space: 2 },
      ),
      preview(
        "address-in-another-case",
        { invitationId: "__org__-inv-ok" },
        {
          seed: async (seeded) => {
            await S.user.update({
              where: { id: seeded.userId },
              data: { email: `${seeded.userId.toUpperCase()}@Example.TEST` },
            });
            await orgInvite(seeded, "ok", mine(seeded));
          },
        },
      ),
      preview(
        "address-with-spaces-around-it",
        { invitationId: "__org__-inv-ok" },
        {
          seed: async (seeded) => {
            await S.user.update({
              where: { id: seeded.userId },
              data: { email: ` ${mine(seeded)} ` },
            });
            await orgInvite(seeded, "ok", mine(seeded));
          },
        },
      ),
      preview(
        "final-sigma-address",
        { invitationId: "__org__-inv-ok" },
        {
          seed: async (seeded) => {
            await S.user.update({
              where: { id: seeded.userId },
              data: { email: "ΑΣ@example.test" },
            });
            await orgInvite(seeded, "ok", "ας@example.test");
          },
        },
      ),
      preview(
        "dotted-capital-i-address",
        { invitationId: "__org__-inv-ok" },
        {
          seed: async (seeded) => {
            await S.user.update({
              where: { id: seeded.userId },
              data: { email: "İ@example.test" },
            });
            await orgInvite(seeded, "ok", "i̇@example.test");
          },
        },
      ),
      preview(
        "unverified-without-email-delivery",
        { invitationId: "__org__-inv-ok" },
        {
          seed: async (seeded) => {
            await unverified(seeded);
            await orgInvite(seeded, "ok", mine(seeded));
          },
        },
      ),
      preview(
        "other-address",
        { invitationId: "__org__-inv-ok" },
        { seed: (seeded) => orgInvite(seeded, "ok", "someone-else@example.test") },
      ),
      preview(
        "expired",
        { invitationId: "__org__-inv-ok" },
        { seed: (seeded) => orgInvite(seeded, "ok", mine(seeded), { expiresIn: -HOUR }) },
      ),
      preview(
        "canceled",
        { invitationId: "__org__-inv-ok" },
        { seed: (seeded) => orgInvite(seeded, "ok", mine(seeded), { status: "canceled" }) },
      ),
      preview(
        "accepted",
        { invitationId: "__org__-inv-ok" },
        { seed: (seeded) => orgInvite(seeded, "ok", mine(seeded), { status: "accepted" }) },
      ),
      preview(
        "organization-being-deleted",
        { invitationId: "__org__-inv-ok" },
        {
          seed: async (seeded) => {
            await orgInvite(seeded, "ok", mine(seeded));
            await S.space.update({
              where: { id: seeded.spaces[0] },
              data: { deletingAt: new Date() },
            });
          },
          space: 1,
        },
      ),
      preview(
        "another-organization",
        { invitationId: "__org__-inv-ok" },
        {
          seed: async (seeded) => {
            const f = await foreignOrg(seeded, "f");
            await orgInvite(seeded, "ok", mine(seeded), {
              org: f.org,
              id: `${seeded.orgId}-inv-ok`,
              by: f.owner,
            });
          },
        },
      ),
      preview("unknown-invitation", { invitationId: "nowhere" }),
      preview("empty-invitation", { invitationId: "" }),
      preview("missing-invitation", {}),
      preview("wrong-type", { invitationId: 5 }),
      preview("extra-keys-are-ignored", { invitationId: "nowhere", more: 1 }),
      preview("not-an-object", []),
      preview("null-input", null),
      preview("no-input", undefined),
      preview(
        "anonymous",
        { invitationId: "__org__-inv-ok" },
        { seed: (seeded) => orgInvite(seeded, "ok", mine(seeded)), anonymous: true },
      ),
      // With the server sending email (run with CONTRACT_EMAIL=1) an invitee must have verified their address.
      preview(
        "with-email-verified",
        { invitationId: "__org__-inv-ok" },
        { seed: (seeded) => orgInvite(seeded, "ok", mine(seeded)), email: true },
      ),
      preview(
        "with-email-unverified",
        { invitationId: "__org__-inv-ok" },
        {
          seed: async (seeded) => {
            await unverified(seeded);
            await orgInvite(seeded, "ok", mine(seeded));
          },
          email: true,
        },
      ),
      preview(
        "with-email-other-address",
        { invitationId: "__org__-inv-ok" },
        {
          seed: async (seeded) => {
            await unverified(seeded);
            await orgInvite(seeded, "ok", "someone-else@example.test");
          },
          email: true,
        },
      ),
      preview("with-email-not-found", { invitationId: "nowhere" }, { email: true }),
    );
  }

  return cases;
}
