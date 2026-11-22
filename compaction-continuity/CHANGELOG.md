# Changelog

## [Unreleased]

### Fixed

- Block todo closure and goal completion after each successful compaction until
  a non-goal/non-todo tool has run, including after core fallback compaction.
- Explicitly distinguish unfinished goals/todos from completed, tool-verified
  work in live state and the final continuity note without changing headings.

### Added

- Standalone compaction continuity extension with live goal and open-todo state,
  concrete completed-work instructions, newer-message precedence, and graceful
  fallback/cancellation.
