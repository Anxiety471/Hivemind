# Linear-inspired task workspace QA

final result: passed

The target is the user's selected Linear screenshot. This is a working Hivemind ticketing interface adapted to that design pattern, with real automated task lifecycle states and Hivemind navigation. It is not a reproduction of Linear's project, cycle, or team-management features.

## Evidence and comparison

- Source visual truth: `/workspace/scratch/44d392184c0c/upload/image(4).png`, 778 × 409 pixels; source CSS viewport and capture density are unknown.
- Populated implementation: `/workspace/scratch/44d392184c0c/qa/hivemind-linear-desktop.png`, 1240 × 660 CSS pixels and image pixels, device scale factor 1.
- Mobile: `/workspace/scratch/44d392184c0c/qa/hivemind-linear-mobile.png`, 390 × 844, device scale factor 1.
- Issue drawer: `/workspace/scratch/44d392184c0c/qa/hivemind-linear-detail.png`, 1440 × 1000, device scale factor 1.
- Final main-integration cloud capture: `/workspace/scratch/44d392184c0c/qa/hivemind-linear-live-20261003.jpg`, 1363 × 936. A fresh disposable V3 hive creates and opens a persisted backlog issue on the final code.
- Cloud browser: `/workspace/scratch/44d392184c0c/qa/hivemind-linear-cloud.jpg`, 1363 × 936. The live browser uses a disposable hive with the repository's scripted Pi runtime. It creates and persists real backlog issues and comments.
- Full comparison: `/workspace/scratch/44d392184c0c/qa/hivemind-linear-comparison.png`. Source and populated implementation were opened together. The implementation was proportionally downsampled to fit the source dimensions; no pixel-perfect claim is made because source density is unknown and app content differs.
- Focused comparison: `/workspace/scratch/44d392184c0c/qa/hivemind-linear-row-comparison.png`. Both content regions were opened together to compare row rhythm, priority/state icons, identifiers, title alignment, inline labels, dates, and assignees.

The populated screenshot uses deterministic fixture data to show review, execution, todo, and blocked groups simultaneously. Separate tests against the actual Rust API verify backlog creation, comments, metadata edits, bulk start, worker execution, independent review, completion, and reload persistence.

## Findings and iterations

1. P1: the previous interface automatically opened a task dashboard next to a narrow card list. Replaced it with a full-width grouped list and a row-initiated drawer. Post-fix evidence: populated desktop/mobile screenshots and cloud browser.
2. P2: inherited light-theme text made the dark toolbar title unreadable. Applied the scoped foreground color; verified the title and count in the populated and cloud screenshots.
3. P2: emoji icons lacked glyphs in the browser environment. Applied Phosphor library icons in the task workspace and navigation, with direct module imports. Verified actual rendered icons in desktop/mobile and cloud captures.
4. P2: native checkboxes used light-theme styling against the dark list. Applied the dark color scheme to the task shell and recaptured the list.

No actionable P0/P1/P2 differences remain within the requested Linear-inspired design pattern.

## Required fidelity surfaces

| Surface | Result |
| --- | --- |
| Fonts and typography | Compact system sans typography, small muted metadata, readable medium-weight titles, and single-line truncation follow the reference hierarchy. Hivemind's existing font stack is retained. |
| Spacing and layout rhythm | Full-width grouped list, flat rows, compact toolbar, sidebar subviews, and aligned metadata replace the split dashboard. Mobile keeps primary ticket fields visible and moves secondary metadata into the drawer. |
| Colors and visual tokens | Charcoal surfaces, restrained group backgrounds and borders, purple creation action, and semantic state colors follow the reference. Changes are scoped to Tasks. |
| Image and asset fidelity | The reference has no content photography or illustrations. Library icons represent states and navigation; actual agent names replace human profile photos. Hivemind branding and existing product navigation are retained. |
| Copy and app-specific content | Real issue titles, stable HM numbers, labels, priorities, and agents replace Linear example content. Group names map to actual scheduler states. Revision counters are omitted from the user-facing issue header. |

## Verification

- Integrated main `b70dba09546ad96c15b030bd65e37cc9df1d4791` (agent wakeups). Issue schema V3 preserves the existing V2 delayed deliveries; a regression test verifies their due times survive.
- 335 Rust tests passed (311 library and 24 binary); formatting and Clippy across all targets/features with warnings denied passed.
- Typecheck and production build passed; existing large-chunk build warning remains.
- 51 frontend unit tests passed, including lifecycle grouping and view membership.
- 14 browser tests passed with four workers on the final main integration, after fixing destructive repeated fixture setup in worker imports. The resumed environment used registry-sourced Chromium 153 with a temporary executable-path override; no extra browser dependency or runtime configuration is committed.
- Real issue flow verified at 1440 × 1000 and 390 × 844; populated grouping/filter/navigation verified at 1240 × 660 and 390 × 844.
- Cloud browser verified creation, priority filtering, filter clearing, group collapse/expand, issue drawer navigation, and comment persistence against a disposable Rust server.
- Browser page identity, no blank render/error overlay, no horizontal overflow, and keyboard dialog dismissal checked.
- No application-origin console errors observed in the final cloud check. The cloud extension reported metadata errors, independent of the app. Automated issue-flow tests reported no page or console errors.

## Follow-up polish

P3: the task workspace shows agent names with a user icon instead of human profile photos. Project badges, cycles, and team-specific navigation are outside the existing Hivemind task model and this change.
