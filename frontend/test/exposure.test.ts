// Run with: bun test test/exposure.test.ts   (or: node --experimental-strip-types --test test/exposure.test.ts)
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  authStatusBadge,
  formatSkillCommand,
  groupHostTools,
  sandboxStatus,
  workspaceBadge,
  HOST_CATEGORY_ORDER,
  HOST_CATEGORY_TITLES,
} from "../src/exposure.ts";
import type { HostToolExposure, RoomExposure } from "../src/api.ts";

test("HOST_CATEGORY_ORDER and HOST_CATEGORY_TITLES cover all six host tool categories", () => {
  assert.deepEqual(HOST_CATEGORY_ORDER, [
    "memory",
    "workspace",
    "wakeup",
    "skills",
    "artifacts",
    "coordination",
  ]);
  assert.equal(HOST_CATEGORY_TITLES.memory, "Memory");
  assert.equal(HOST_CATEGORY_TITLES.workspace, "Workspace");
  assert.equal(HOST_CATEGORY_TITLES.wakeup, "Wakeup");
  assert.equal(HOST_CATEGORY_TITLES.skills, "Skills");
  assert.equal(HOST_CATEGORY_TITLES.artifacts, "Library");
  assert.equal(HOST_CATEGORY_TITLES.coordination, "Coordination");
});

test("groupHostTools groups tools by category and maintains canonical ordering", () => {
  const tools: HostToolExposure[] = [
    {
      name: "coordination.broadcast",
      category: "coordination",
      available: true,
      allowed: true,
      permission: "coordination.broadcast",
      description: "Broadcast to room",
    },
    {
      name: "memory.read",
      category: "memory",
      available: true,
      allowed: true,
      permission: "memory.read",
      description: "Read memory",
    },
    {
      name: "workspace.write",
      category: "workspace",
      available: true,
      allowed: false,
      permission: "workspace.write",
      description: "Write files",
    },
    {
      name: "memory.write",
      category: "memory",
      available: true,
      allowed: true,
      permission: "memory.write",
      description: "Write memory",
    },
  ];

  const grouped = groupHostTools(tools);
  assert.equal(grouped.length, 3);
  // Memory comes first in HOST_CATEGORY_ORDER, then workspace, then coordination
  assert.equal(grouped[0].category, "memory");
  assert.equal(grouped[0].title, "Memory");
  assert.equal(grouped[0].tools.length, 2);
  assert.equal(grouped[0].tools[0].name, "memory.read");
  assert.equal(grouped[0].tools[1].name, "memory.write");

  assert.equal(grouped[1].category, "workspace");
  assert.equal(grouped[1].title, "Workspace");
  assert.equal(grouped[1].tools.length, 1);
  assert.equal(grouped[1].tools[0].name, "workspace.write");

  assert.equal(grouped[2].category, "coordination");
  assert.equal(grouped[2].title, "Coordination");
  assert.equal(grouped[2].tools.length, 1);
});

test("groupHostTools filters out empty categories and handles unknown categories", () => {
  const tools: HostToolExposure[] = [
    {
      name: "custom.plugin",
      category: "custom_plugin" as unknown as HostToolExposure["category"],
      available: true,
      allowed: true,
      permission: null,
      description: "Custom plugin tool",
    },
  ];

  const grouped = groupHostTools(tools);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].category, "other");
  assert.equal(grouped[0].title, "Other");
  assert.equal(grouped[0].tools[0].name, "custom.plugin");
});

test("groupHostTools returns empty array for empty tool list", () => {
  assert.deepEqual(groupHostTools([]), []);
});

test("formatSkillCommand formats command with and without argument hint", () => {
  assert.equal(formatSkillCommand({ name: "review" }), "/skill:review");
  assert.equal(formatSkillCommand({ name: "review", argument_hint: "" }), "/skill:review");
  assert.equal(formatSkillCommand({ name: "review", argument_hint: "   " }), "/skill:review");
  assert.equal(
    formatSkillCommand({ name: "review", argument_hint: "[pr-number] [flags]" }),
    "/skill:review [pr-number] [flags]",
  );
});

test("authStatusBadge returns warning for restricted and ok for unrestricted", () => {
  assert.deepEqual(authStatusBadge(true), {
    label: "Restricted (deny-by-default)",
    tone: "warn",
  });
  assert.deepEqual(authStatusBadge(false), {
    label: "Unrestricted",
    tone: "ok",
  });
});

test("sandboxStatus returns expected labels and tones for all controls", () => {
  assert.deepEqual(sandboxStatus("file_editing", true), {
    label: "Allowed",
    tone: "ok",
  });
  assert.deepEqual(sandboxStatus("file_editing", false), {
    label: "Denied (read-only)",
    tone: "muted",
  });

  assert.deepEqual(sandboxStatus("shell_execution", true), {
    label: "Allowed",
    tone: "ok",
  });
  assert.deepEqual(sandboxStatus("shell_execution", false), {
    label: "Denied",
    tone: "muted",
  });

  assert.deepEqual(sandboxStatus("web_access", true), {
    label: "Enabled",
    tone: "ok",
  });
  assert.deepEqual(sandboxStatus("web_access", false), {
    label: "Disabled",
    tone: "muted",
  });
});

test("workspaceBadge returns distinct tone and label for shared vs private", () => {
  assert.deepEqual(workspaceBadge(true), {
    label: "Group-shared workspace",
    tone: "info",
  });
  assert.deepEqual(workspaceBadge(false), {
    label: "Agent-private workspace",
    tone: "muted",
  });
});

test("RoomExposure schema satisfies API contract structure", () => {
  const exposure: RoomExposure = {
    room_id: "group-eng",
    room_kind: "group",
    room_name: "Engineering",
    agents: [
      {
        persona_id: "backend",
        runtime: "pi",
        model: "anthropic/claude-3-5-sonnet",
        reasoning: "high",
        fast: false,
        role: "backend-lead",
        workspace: {
          effective: "/home/user/workspaces/eng",
          is_shared: true,
          source: "group",
        },
        authorization: {
          restricted: true,
          roles: ["engineer"],
          permissions: ["workspace.write", "memory.private.write"],
          capabilities: ["code-editing"],
          sandbox: {
            file_editing: true,
            shell_execution: true,
            web_access: false,
          },
        },
        tools: {
          runtime: [
            {
              name: "edit",
              category: "fs_write",
              allowed: true,
              description: "Edit files",
              reason: null,
            },
            {
              name: "web_search",
              category: "web",
              allowed: false,
              description: "Search web",
              reason: "Web access is disabled for this agent",
            },
          ],
          host: [
            {
              name: "memory.write",
              category: "memory",
              available: true,
              allowed: true,
              permission: "memory.write",
              description: "Write memory records",
            },
          ],
        },
      },
    ],
    skills: [
      {
        name: "test-runner",
        description: "Run test suite",
        argument_hint: "<filter>",
        source: "/home/user/.skills",
      },
    ],
  };

  assert.equal(exposure.room_id, "group-eng");
  assert.equal(exposure.agents.length, 1);
  assert.equal(exposure.agents[0].authorization.sandbox.file_editing, true);
  assert.equal(exposure.agents[0].tools.runtime[1].allowed, false);
  assert.equal(exposure.skills[0].name, "test-runner");
});
