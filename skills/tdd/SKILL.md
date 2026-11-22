---
name: tdd
description: Test-driven development (red → green) at pre-agreed seams. Use when building a feature or fixing a bug test-first, when a brief or subagent-orchestration Phase 2 asks for TDD, or when the user mentions red-green or integration tests. Skip for log-only, config-only, or docs changes.
version: "1"
---

# Test-Driven Development

Adapted from mattpocock/skills `skills/engineering/tdd` (upstream commit abeeaf9, 2026-11-19). Upstream calls `codebase-design` and `code-review` skills that this setup does not have; their roles map to the seam vocabulary below and to subagent-orchestration Phase 3.

TDD is the red → green loop. This skill says what a test worth keeping looks like, where tests go, the anti-patterns, and the rules of the loop. Every section applies on every cycle.

Before writing tests, read the repo's `AGENTS.md`, its docs map (`docs/README.md` if present), any glossary, and ADRs in the area you touch, so test names use the project's vocabulary and respect its decisions. Use the repo's own test runner and commands; do not invent new ones.

## When it applies

Only when the task has testable code logic. Log-only, config-only, and docs changes skip TDD; the live test gate still applies.

## What a good test is

Tests verify behavior through public interfaces, not implementation details. Code can change entirely; tests should not. A good test reads like a specification ("user can checkout with valid cart") and survives refactors because it does not depend on internal structure.

Examples: [references/tests.md](references/tests.md). Mocking: [references/mocking.md](references/mocking.md).

## Seams: where tests go

A **seam** is the public boundary you test at: the interface where you observe behavior without reaching inside. Tests live at seams, never against internals.

- **Seams are settled before any test is written.** Propose the seams under test, each with one line on what it **catches** and what it **misses**, and get approval (the user, or the Boss/parent when running as a subagent). No test at an unapproved seam.
- As a subagent, the seams come from the brief. If the brief has none, stop and report instead of choosing them yourself.
- What a seam misses is tagged `[NEEDS-MEASUREMENT]` in the report; it is covered by the live test or review, not silently assumed.
- If the interface shape itself is in question (how deep the module is, where the seam belongs, what it should expose), raise it as a finding before writing tests; do not redesign the module inside the loop.

## Anti-patterns

- **Implementation-coupled**: mocks internal collaborators, tests private methods, or verifies through a side channel (querying the database instead of using the interface). The tell: the test breaks on a refactor that did not change behavior.
- **Tautological**: the expected value is recomputed the way the code computes it (`expect(add(a, b)).toBe(a + b)`), so the test passes by construction. Expected values come from an independent source: a known-good literal, a worked example, the spec. Never derive them from the code's logic.
- **Horizontal slicing**: writing all tests first, then all implementation. Bulk tests verify imagined behavior and lock in test structure before you understand the code. Work in vertical slices: one test → one implementation → repeat, each test responding to what the last cycle taught you.

## Rules of the loop

- **Red before green.** Write the failing test, run it, and see it fail for the expected reason. Then write only enough code to pass. No speculative features.
- **One slice at a time.** One seam, one test, one minimal implementation per cycle.
- **No refactoring in the loop.** Refactor ideas become findings for review (subagent-orchestration Phase 3); the parent decides after review.
- **Test files are in scope.** When running as an implement subagent, the test files must be listed in `allowFiles`.
- **Run tests often.** Run the single test file each cycle and the repo's full authoritative verification (tests, typecheck, lint, as the project defines) once at the end.

## Done

Report per seam: the test names, red and green evidence (the command and the failing then passing result), and the misses tagged `[NEEDS-MEASUREMENT]`. Green unit tests do not replace the live test gate.
