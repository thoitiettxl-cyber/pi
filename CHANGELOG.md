# Changelog

## [Unreleased]

### Added

- Compaction continuity hook using pi's built-in summarizer: concrete completed
  work, unfinished-only next steps, and newer-message precedence without redoing
  completed steps. Preserves custom instructions, cancellation, and default fallback.

## [0.1.0]

### Added

- Standalone native Devin provider for pi with browser PKCE login, manual
  callbacks, Devin CLI credential adoption, and DEVIN_API_KEY authentication.
- Account-scoped model discovery and persistent catalogs, thinking-effort
  routing, and adaptive model assignment.
- Cascade Connect-protobuf streaming, thinking, tools, images, usage, errors,
  cancellation, and request hooks without runtime dependencies.
- Mocked protocol/auth/discovery tests and documented opt-in live checks.
