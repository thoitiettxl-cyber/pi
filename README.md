# Compaction continuity for pi

Keep long sessions from repeating completed work after compaction. This standalone
extension uses pi's own compactor with concrete Done entries and unfinished-only
In Progress / Next Steps, then adds a reminder that newer retained messages take
precedence. It does not install or register a model provider or modify pi core.

## Install

Requires pi 1.6.0 or later and Node.js 22.19.0 or later:

```sh
pi install git:github.com/thoitiettxl-cyber/pi@compaction-continuity
```

Do not load another extension that replaces `session_before_compact` alongside it
(including the earlier provider-devin continuity workaround).

## Goal and todos

Works with Ai's `goal.ts` and `todos.ts` without importing or bundling them:

- Reads the latest `customType: "goal"` entry on the current session branch.
  Uses `data.goal` objective, status and optional token usage/budget. A cleared
  (`null`) goal is omitted; older goals are not resurrected.
- Reads `.pi/todos` relative to the project, or `PI_TODO_PATH` (trimmed and resolved
  relative to the project, exactly like `todos.ts`). The todo extension's settings
  control garbage collection, not the storage path.
- Reads JSON front matter followed by Markdown. Includes filename ID, title,
  status and `assigned_to_session` as assignee. `closed` / `done` (case-insensitive)
  are completed, never pending. At most 30 open and 30 closed records are supplied
  to the summarizer; omitted counts are explicit.
- Supplies live state to the summarizer and appends a `<live-state>` snapshot
  containing the goal and only open todos, followed by the continuity note last.

Missing state is silently omitted. Read failures cannot prevent compaction.
Missing model/auth and non-abort failures fall back to pi's default compaction;
aborts cancel it. No files or goal/todo entries are changed by this extension.
Snapshots reflect compaction time, not subsequent changes. Newer messages still
take precedence. Neither the goal nor todo extension is required.

## Development

```sh
npm ci --ignore-scripts
npm run check
npm test
```
