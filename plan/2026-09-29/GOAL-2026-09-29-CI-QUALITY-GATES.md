# GOAL — 2026-09-29 — CI Quality Gates

## Objective

Bring CI in line with the quality gates already referenced throughout the Hivemind plans.

The latest main-branch CI is green, and formatting has been fixed.

Current workflow runs:

```text
cargo fmt --all --check
cargo test --all-targets
```

The remaining gap is that Clippy is repeatedly listed as an acceptance gate in plans but is not enforced by GitHub Actions.

The rule is:

```text
If a quality gate matters, CI must enforce it.
```

## Rust toolchain components

Install both:

```text
rustfmt
clippy
```

using the stable toolchain.

## Required checks

CI should run at minimum:

```bash
cargo fmt --all --check
cargo test --all-targets
cargo clippy --all-targets --all-features -- -D warnings
```

If `--all-features` currently has no effect, keep it anyway so future optional features are covered automatically.

## Dependency reproducibility

Because `Cargo.lock` is committed for this application, prefer locked CI execution where practical:

```bash
cargo test --locked --all-targets
cargo clippy --locked --all-targets --all-features -- -D warnings
```

Do not use `--locked` if the repository intentionally changes to a library-only lockfile policy later.

## Check ordering

Keep cheap failures early:

```text
format
  |
clippy/check
  |
tests
```

or run tests and Clippy in parallel after formatting.

The goal is fast feedback without weakening gates.

## Caching

Cargo caching is optional.

Do not add a complicated cache setup merely to save seconds on this repository.

If added, use a standard maintained Rust cache action and ensure cache failure does not break correctness.

## Branch protection integration

The workflow check name should remain stable enough to be used by repository rulesets later.

Do not rename the CI job on every refactor.

## Validation

Validate the workflow by pushing the change and confirming:

- formatting passes,
- Clippy passes with warnings denied,
- tests pass,
- the workflow conclusion is success.

## Acceptance criteria

1. CI installs Clippy.
2. CI runs `cargo clippy --all-targets --all-features -- -D warnings`.
3. CI still checks rustfmt.
4. CI still runs all-target tests.
5. Lockfile usage is explicit and reproducible where appropriate.
6. The main branch returns to green after the CI update.
7. No provider credentials or live model calls are required by CI.

## Non-goals

Do not expand this into:

- release automation,
- package publishing,
- deployment,
- coverage SaaS,
- benchmark infrastructure,
- nightly Rust,
- multi-platform matrices unless a concrete portability bug requires them.

This is a small plan on purpose. CI should be boring. Humanity has enough exciting failure modes already.
