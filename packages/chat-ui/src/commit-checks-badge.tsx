import type { CommitCheck, CommitCheckState } from "@rakazo/contracts";
import { Popover, PopoverContent, PopoverTrigger } from "@rakazo/ui-web";
import { useContext } from "react";
import type { CommitCheckTarget } from "./commit-checks";
import {
  CommitChecksContext,
  commitCheckSeconds,
  commitCheckTarget,
  summarizeCommitChecks,
} from "./commit-checks";
import { useMarkdownCopy } from "./markdown-copy";
import "./commit-checks-badge.css";

/** The state glyph for one check, or for a commit's summary tone. Decorative: names come from text. */
export function CheckStateGlyph({ state }: { state: CommitCheckState | "running" }) {
  if (state === "running" || state === "queued") {
    return (
      <span
        aria-hidden="true"
        className={state === "running" ? "rk-check-ring" : "rk-check-ring rk-check-ring-queued"}
      />
    );
  }
  if (state === "passed") {
    return (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="m5 13 4 4L19 7"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (state === "failed") {
    return (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M6 6l12 12M18 6 6 18"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 12h14" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

function CheckRow({ check }: { check: CommitCheck }) {
  const copy = useMarkdownCopy();
  const seconds = commitCheckSeconds(check);
  return (
    <li className="rk-check-row">
      <span
        className="rk-check-row-state"
        data-state={check.state}
        role="img"
        aria-label={copy.checkStates[check.state]}
      >
        <CheckStateGlyph state={check.state} />
      </span>
      {check.url ? (
        <a className="rk-check-row-name" href={check.url} target="_blank" rel="noopener noreferrer">
          {check.name}
        </a>
      ) : (
        <span className="rk-check-row-name">{check.name}</span>
      )}
      {seconds === undefined ? null : (
        <span className="rk-check-row-time">{copy.checkSeconds(seconds)}</span>
      )}
    </li>
  );
}

/**
 * The CI status beside a commit or pull request link: a spinning ring while checks run, a check or
 * a cross when they have finished, and nothing when there is no data. Opens the list of checks.
 */
export function CommitChecksBadge({ target }: { target: CommitCheckTarget }) {
  const copy = useMarkdownCopy();
  const checks = useContext(CommitChecksContext).use(target);
  const summary = summarizeCommitChecks(checks);
  if (!summary || !checks) return null;
  const label =
    summary.tone === "failed"
      ? copy.checksFailed
      : summary.tone === "passed"
        ? copy.checksPassed
        : copy.checksProgress(summary.passed, summary.total);
  return (
    <Popover>
      <PopoverTrigger aria-label={label} className="rk-check-status" data-tone={summary.tone}>
        <CheckStateGlyph
          state={
            summary.tone === "running" ? "running" : summary.tone === "failed" ? "failed" : "passed"
          }
        />
      </PopoverTrigger>
      <PopoverContent align="start" className="rk-check-list" data-testid="commit-checks">
        <ul>
          {checks.map((check) => (
            <CheckRow key={check.name} check={check} />
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The CI status beside a commit or pull request link. It sits after the link's hover card, not
 * inside it: a control cannot nest in an anchor, and the card's trigger wraps only the link.
 */
export function LinkChecks({ href }: { href: string }) {
  const target = commitCheckTarget(href);
  return target ? <CommitChecksBadge target={target} /> : null;
}
