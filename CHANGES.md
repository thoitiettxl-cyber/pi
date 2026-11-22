# Changes to the pi setup (tested on Debian bookworm x86_64, pi 1.6.0, Devin provider)

Install: unzip to a directory, `pi install <dir>`, copy `AGENTS.md` to `~/.pi/agent/AGENTS.md`.

## Fixed
- Exec bits lost in the archive: `intercepted-commands/*`, tmux scripts, web-browser entry scripts, `librarian/checkout.sh`, `summarize/to-markdown.mjs`, `native-web-search/search.mjs` failed with "Permission denied" (uv shims silently inactive). Restored `+x`.
- summarize `--summary` hard-coded `anthropic/claude-haiku-4-5` and failed without an Anthropic key. Now uses the session model (`PI_PROVIDER`/`PI_MODEL`); override with `SUMMARIZE_PROVIDER`/`SUMMARIZE_MODEL`.
- tmux `wait-for-text.sh` could not read a pane on the private socket the skill requires (always timed out). Added `-S`/`-L`.
- tmux SKILL.md used `tmux -L "$SOCKET"` (socket name) with a socket path; changed to `-S`. Renamed claude-* sockets/sessions to pi-* (`PI_TMUX_SOCKET_DIR`, old `CLAUDE_TMUX_SOCKET_DIR` still read). Debugger: lldb if installed, else gdb.

## Changed
- subagent-orchestration: replaced obsolete Muse `subagent.spawn` syntax with the pi `subagent` tool roles and required fields.
- ambition-amplifier: `$ambition-amplifier` (Codex syntax) -> `/skill:ambition-amplifier`.
- native-web-search, search-playbook: local fallback (web-browser `read.js`, summarize, `gh search`) when Exa/Firecrawl are not installed; the `devin` provider has no native search.
- AGENTS.md: added "Tools in this setup" (todo, goal, subagent, uv, search/librarian/web-browser/summarize, xia, commit), tmux wait rule, Host lines (Debian on Android, check `uname -m`, stop background processes).

## Removed
- `skills/*/agents/openai.yaml` (Codex-only metadata) in prompt-leverage, sequence-execution-plan, xia.

## Verified unchanged
control (`--session-control`, `list_sessions`), goal, todos, unified-edit, uv, subagent (+17/17 policy tests), xai-capacity-retry, librarian, prompt-leverage (2/2 tests), web-browser (Obscura 0.2.7: read/start/nav/eval/screenshot), markitdown.

## Not verified
- aarch64/Android: tested on x86_64 only. Obscura publishes `aarch64-linux` assets.
- Exa/Firecrawl/Context7 routes (MCP servers not in this archive).

## Added: `tdd` skill
- `skills/tdd/` re-synced from mattpocock/skills `skills/engineering/tdd` (upstream commit abeeaf9, 2026-11-19), so subagent-orchestration Phase 2 (`/skill:tdd`) resolves to a real skill.
- Normalized to this setup: seams approved by the user or Boss/parent (a subagent takes them from the brief), misses tagged `[NEEDS-MEASUREMENT]`, no refactoring in the loop (goes to Phase 3 review), test files listed in `allowFiles`, live test gate still required. Upstream calls to the missing `codebase-design`/`code-review` skills and the Codex `agents/openai.yaml` were dropped. `tests.md`/`mocking.md` kept verbatim under `references/`.
- Tested: `pi -p "/skill:tdd ..."` with the Devin provider loads the skill and answers from it.
