import { expectLinearTime } from "@rakazo/contracts/test-timing";
import { buildSkillMd } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { BUILTIN_AGENT_SKILLS } from "./builtin-skills.prompt.js";
import type { SearchableSkill } from "./skill-search.js";
import { matchRelevantSkillsForPrompt, searchSkills } from "./skill-search.js";

function builtinCorpus(): SearchableSkill[] {
  return BUILTIN_AGENT_SKILLS.map((skill) => ({
    id: `builtin:${skill.name}`,
    name: skill.name,
    description: skill.description,
    source: "builtin" as const,
    readOnly: true,
    content: skill.content,
  }));
}

function fullCorpus(): SearchableSkill[] {
  return [
    ...builtinCorpus(),
    {
      id: "user:deploy-web",
      name: "Deploy Web Frontend",
      description: "Build and ship web UI changes to production",
      source: "user",
      readOnly: false,
      content: buildSkillMd({
        name: "Deploy Web Frontend",
        description: "Build and ship web UI changes to production",
        body: [
          "## Build & Bundle",
          "Run pnpm --filter @rakazo/web build and check asset hashes.",
          "## Rollout & Verification",
          "Restart web service and verify the served bundle hash.",
        ].join("\n"),
        frontmatter: {
          tags: ["deploy", "frontend", "production"],
          triggers: ["ship web", "deploy frontend"],
        },
      }),
      filePaths: ["references/nginx-reload.md", "scripts/verify-hash.sh"],
    },
    {
      id: "plugin:billing-rates",
      name: "Cloud Billing",
      description: "Inspect workspace invoices, credits, and usage tiers",
      source: "plugin",
      readOnly: true,
      content: buildSkillMd({
        name: "Cloud Billing",
        description: "Inspect workspace invoices, credits, and usage tiers",
        body: "## Usage Tiers\nCheck credit balance and rate tables in references/tier-pricing.md.",
      }),
      filePaths: ["references/tier-pricing.md"],
    },
    {
      id: "taught:expense-report",
      name: "Submit Expense Report",
      description: "When user uploads a receipt or asks to file expenses",
      source: "taught",
      readOnly: true,
      content: [
        "Run taught skill: Submit Expense Report",
        "When to use: When user uploads a receipt or asks to file expenses",
        "Steps:",
        "1. Open accounting portal.",
        "2. Upload receipt PDF and select vendor category.",
        "3. Submit reimbursement request.",
      ].join("\n"),
      whenToUse: "When user uploads a receipt or asks to file expenses",
    },
    {
      id: "user:cjk-weekly",
      name: "週次レポート",
      description: "毎週の売上レポートと進捗をまとめる",
      source: "user",
      readOnly: false,
      content: buildSkillMd({
        name: "週次レポート",
        description: "毎週の売上レポートと進捗をまとめる",
        body: "## 手順\n売上データを確認して要約を作成する。",
      }),
    },
  ];
}

describe("skill-search BM25F engine", () => {
  it("ranks exact name and trigger matches ahead of incidental body mentions", () => {
    const skills: SearchableSkill[] = [
      {
        id: "1",
        name: "Notes",
        description: "Take general notes",
        source: "user",
        readOnly: false,
        content: buildSkillMd({
          name: "Notes",
          description: "Take general notes",
          body: "Deploy deploy deploy deploy deploy deploy deploy checklist.",
        }),
      },
      {
        id: "2",
        name: "Deploy",
        description: "Ship changes safely",
        source: "user",
        readOnly: false,
        content: buildSkillMd({
          name: "Deploy",
          description: "Ship changes safely",
          body: "Run build and restart.",
        }),
      },
    ];
    const result = searchSkills(skills, "deploy");
    expect(result.hits[0]?.skill.name).toBe("Deploy");
    expect(result.hits[0]?.exactNameMatch).toBe(true);
    expect(result.autoExpand?.skill.name).toBe("Deploy");
  });

  it("extracts matched markdown headings, reference file paths, and snippets", () => {
    const corpus = fullCorpus();
    const headingHit = searchSkills(corpus, "verify served bundle hash");
    expect(headingHit.hits[0]?.skill.name).toBe("Deploy Web Frontend");
    expect(headingHit.hits[0]?.matchedHeading).toBe("Rollout & Verification");
    expect(headingHit.hits[0]?.snippet).toBeTruthy();

    const fileHit = searchSkills(corpus, "tier pricing");
    expect(fileHit.hits[0]?.skill.name).toBe("Cloud Billing");
    expect(fileHit.hits[0]?.matchedIn).toContain("files");
  });

  it("supports synonyms, bounded typos, taught skills, and CJK queries", () => {
    const corpus = fullCorpus();

    expect(searchSkills(corpus, "audit this pull request").hits[0]?.skill.name).toBe("Interrogate");
    expect(searchSkills(corpus, "interogate this diff").hits[0]?.skill.name).toBe("Interrogate");
    expect(searchSkills(corpus, "cron job skipping quiet runs").hits[0]?.skill.name).toBe(
      "Routines",
    );
    expect(searchSkills(corpus, "file receipt reimbursement").hits[0]?.skill.name).toBe(
      "Submit Expense Report",
    );
    expect(searchSkills(corpus, "売上レポート").hits[0]?.skill.name).toBe("週次レポート");
  });

  it("does not auto-expand when hits are ambiguous or when content exceeds 24 KB", () => {
    const tied: SearchableSkill[] = [
      {
        id: "a",
        name: "Alpha Sync",
        description: "Sync calendar events",
        source: "user",
        readOnly: false,
        content: buildSkillMd({
          name: "Alpha Sync",
          description: "Sync calendar events",
          body: "Sync calendar.",
        }),
      },
      {
        id: "b",
        name: "Beta Sync",
        description: "Sync calendar invites",
        source: "user",
        readOnly: false,
        content: buildSkillMd({
          name: "Beta Sync",
          description: "Sync calendar invites",
          body: "Sync calendar.",
        }),
      },
    ];
    const ambiguous = searchSkills(tied, "sync calendar");
    expect(ambiguous.hits).toHaveLength(2);
    expect(ambiguous.autoExpand).toBeUndefined();

    const oversized: SearchableSkill[] = [
      {
        id: "big",
        name: "Massive Playbook",
        description: "Huge guide",
        source: "user",
        readOnly: false,
        content: buildSkillMd({
          name: "Massive Playbook",
          description: "Huge guide",
          body: "detail ".repeat(5_000),
        }),
      },
    ];
    const largeRes = searchSkills(oversized, "Massive Playbook");
    expect(largeRes.hits[0]?.skill.name).toBe("Massive Playbook");
    expect(largeRes.autoExpand).toBeUndefined();
  });

  describe("accuracy & calibration benchmark", () => {
    const corpus = fullCorpus();

    const positiveCases: Array<{ prompt: string; expectedTop3: string }> = [
      { prompt: "Do an adversarial review of PR #42", expectedTop3: "Interrogate" },
      { prompt: "Can you interrogate this plan before we merge?", expectedTop3: "Interrogate" },
      { prompt: "How does billing work in Rakazo?", expectedTop3: "Rakazo" },
      { prompt: "Track this multi-step feature on the Kanban board", expectedTop3: "Tasks" },
      {
        prompt: "Check earlier messages from last week beyond our window",
        expectedTop3: "History",
      },
      { prompt: "Create a recurring cron routine that skips empty runs", expectedTop3: "Routines" },
      { prompt: "Open Chrome browser and fill the login secret", expectedTop3: "Computer" },
      {
        prompt: "Delegate these three repo checks in parallel to helpers",
        expectedTop3: "Subagents",
      },
      {
        prompt: "Ship the web frontend changes to prod and check nginx reload",
        expectedTop3: "Deploy Web Frontend",
      },
      { prompt: "Check workspace invoice tier pricing", expectedTop3: "Cloud Billing" },
      {
        prompt: "Upload my receipt PDF for expense reimbursement",
        expectedTop3: "Submit Expense Report",
      },
      { prompt: "今週の売上レポートをまとめて", expectedTop3: "週次レポート" },
    ];

    it.each(positiveCases)(
      "surfaces $expectedTop3 in top-3 for prompt %j",
      ({ prompt, expectedTop3 }) => {
        const searchTop3 = searchSkills(corpus, prompt, { limit: 3 }).hits.map((h) => h.skill.name);
        expect(searchTop3).toContain(expectedTop3);

        const hintNames = matchRelevantSkillsForPrompt(prompt, corpus, { maxHints: 3 }).map(
          (h) => h.name,
        );
        expect(hintNames).toContain(expectedTop3);
      },
    );

    const hardNegatives = [
      "hi",
      "thanks!",
      "okay got it",
      "yes please",
      "what is 2 + 2?",
      "review my grocery list",
      "summarize this paragraph in two sentences",
      "can you help me?",
      "write a haiku about rain",
    ];

    it.each(hardNegatives)("emits zero pre-turn hints for unrelated/casual prompt %j", (prompt) => {
      expect(matchRelevantSkillsForPrompt(prompt, corpus)).toEqual([]);
    });

    it("excludes skills already expanded via /Name or @Name", () => {
      const hints = matchRelevantSkillsForPrompt("Track this on the Kanban board", corpus, {
        excludeNames: ["Tasks"],
      });
      expect(hints.map((hint) => hint.name)).not.toContain("Tasks");
    });
  });

  it("scales linearly over large skill catalogs", () => {
    const manySkills: SearchableSkill[] = Array.from({ length: 400 }, (_, index) => ({
      id: `skill-${index}`,
      name: `Workflow ${index}`,
      description: `Handles step ${index} for workspace automation and data sync`,
      source: "user",
      readOnly: false,
      content: buildSkillMd({
        name: `Workflow ${index}`,
        description: `Handles step ${index} for workspace automation and data sync`,
        body: `## Step ${index}\nVerify item ${index} and save report.`,
      }),
    }));
    expectLinearTime(() => {
      const res = searchSkills(manySkills, "workspace automation report 342");
      expect(res.hits[0]?.skill.name).toBe("Workflow 342");
    });
  });
});
