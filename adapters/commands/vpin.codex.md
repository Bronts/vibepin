# vpin — vibepin file-watcher loop (Codex)

Watch this project's vibepin inbox **and this session's own queue**, and implement UI
annotations as they arrive — the token-cheap way. Do NOT use the `watch_annotations`
MCP tool; it long-polls and burns tokens while idle. This loop blocks in the shell
instead, so no model tokens are spent while you wait.

Prerequisite: vibepin is installed in this project, so `npx vibepin` resolves.

Session routing (v2): the panel can send a note either to **broadcast**
(`.vibepin/inbox.jsonl`, every parked session in this project wakes) or to **one session**
(`.vibepin/sessions/<sid>.jsonl`). A watcher only wakes for the files it watches, so this
loop watches **both**.

1. Pick ONE session id and reuse it on every re-arm below — a short `<agent>-<6hex>` like
   `codex-9b1e04` (allowed: `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`).

2. Run this and wait for it — it blocks until **either** this session's queue or the shared
   inbox changes, then exits:

   `npx vibepin watch --queue .vibepin/sessions/<sid>.jsonl --session <sid>`

   (`--inbox` defaults to `./.vibepin/inbox.jsonl`.) No tokens are spent while it blocks.
   Note: Codex sandboxes shell subprocesses without network access — that is fine, this loop
   only writes files and never calls the daemon over HTTP.

3. When it returns, run:

   `npx vibepin claim --queue .vibepin/sessions/<sid>.jsonl --session <sid>`

   It drains this session's queue **plus** the shared inbox (queue batch first, de-duplicated
   by `id`), archives them to `processed.jsonl`, and prints a JSON array — implement each:
   - `kind: "element"` → prefer `component` + `source` (React) to open the right file;
     otherwise use `selector` / `html` / `styles`.
   - `kind: "region"` → use `rect` + `elements` (the components inside the box).
   Say briefly what you changed and which files. (`claim` already archives them — there is
   no separate resolve step.)

4. Go back to step 2. Claim **before** re-arming, every round.

If a targeted note ever piles up (someone stopped passing `--queue`), recover it with
`npx vibepin sessions` (lists each sid + pending + last activity) and
`npx vibepin claim --queue .vibepin/sessions/<sid>.jsonl`.

Stop when I interrupt you.
