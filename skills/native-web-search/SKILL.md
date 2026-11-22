---
name: native-web-search
description: "Run provider-native web search via search.mjs with this session's PI_PROVIDER/PI_MODEL. Use when search-playbook routes news or current facts here, or for a short sourced recency check. Do not use for how-to, code, company/people, JS-heavy pages, site crawls, or library/vendor docs (Exa, Firecrawl, Context7, vendor MCP). Not a Pi function tool. If the script reports native search is not implemented, call Exa web_search_exa then Firecrawl firecrawl_search; do not retry with another --provider."
---

# Native Web Search

Provider built-in search, not a Pi function tool. Do not look for a `web_search` tool.

Load **search-playbook** to choose a channel. Load this skill only to run native search.

## Command

Run from this skill directory. Omit `--provider` and `--model` so the script uses session `PI_PROVIDER` / `PI_MODEL`.

```bash
node search.mjs "<query>" --purpose "<why you need this>"
```

Examples:

```bash
node search.mjs "latest python release" --purpose "update dependency notes"
node search.mjs "vite 7 breaking changes" --purpose "prepare migration checklist"
```

## Overrides

Pass only when you must leave the session model:

- `--provider <id>`
- `--model <model-id>`
- `--timeout <ms>`
- `--json`

Do not default to a mini/haiku model.

## Output

Default stdout:

```
Provider: <provider>
Model: <model-id>

<concise summary>
```

Expect 3–7 findings, each with a full `https://...` URL; disagreements called out; a short which-source-to-trust-first note.

`--json` prints `{ provider, model, query, purpose, result }`.

A snippet is not a fact. Read origin pages with `web_fetch_exa` or `firecrawl_scrape` before concluding.

## If it fails

If the script reports native search is **not implemented** for this model, that is not an empty web result.

Next action, in order:

1. Exa `web_search_exa`
2. Firecrawl `firecrawl_search`

Do **not** retry with another `--provider` or a mini/haiku model.
