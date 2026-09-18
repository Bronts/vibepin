---
description: vibepin · start the token-cheap file-watcher loop in this project
---
Watch this project's vibepin inbox **and this session's own queue**, and implement
annotations as they arrive — the token-cheap way. Do NOT call the `watch_annotations`
MCP tool (it polls and burns tokens while idle).

Prerequisite: this project has vibepin installed, so `npx vibepin` resolves.

Session routing (v2): the panel can send a note either to **broadcast** (`.vibepin/inbox.jsonl`,
everyone parked in this project gets it) or to **one session** (`.vibepin/sessions/<sid>.jsonl`).
A watcher only wakes for the files it was told to watch, so this loop watches **both**.

1. Pick ONE session id for this session and reuse it on every re-arm below — a short
   `<agent>-<6hex>` like `claude-3f7a2c` (allowed: `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`; keep it
   short, the overlay shows it verbatim). If you already armed this session, reuse the same id.

2. Launch in the BACKGROUND (run_in_background: true); do not block this turn:

   `npx vibepin watch --queue .vibepin/sessions/<sid>.jsonl --session <sid>`

   It blocks until **either** that queue or the shared inbox changes (and exits immediately if
   the queue already has unclaimed notes). `--inbox` defaults to `./.vibepin/inbox.jsonl`, so
   passing the two flags above is enough. No tokens are spent while it blocks. Once it is
   running, end the turn and hand control back to me.

3. When that background process exits, run:

   `npx vibepin claim --queue .vibepin/sessions/<sid>.jsonl --session <sid>`

   It drains this session's queue **plus** the shared inbox (queue batch first, de-duplicated by
   `id`), archives them to `processed.jsonl`, and prints a JSON array — implement each annotation:
   - `kind: "element"` → prefer `component` + `source` (React) to open the right file;
     otherwise use `selector` / `html` / `styles`.
   - `kind: "region"` → use `rect` + `elements` (the components inside the box).
   Briefly say what you changed and which files. (`claim` already archives them — there is
   no separate resolve step.)

4. Re-launch step 2 in the background, then end the turn.

Claim **before** re-arming, every round — never re-arm over a batch you haven't drained.
While the watcher is blocking you are idle and spend no tokens. I may type other (non-UI)
requests in the meantime — handle them normally, then make sure the watcher is still armed.

If a targeted note ever piles up (someone stopped passing `--queue`), recover it with
`npx vibepin sessions` (lists each sid + pending + last activity) and
`npx vibepin claim --queue .vibepin/sessions/<sid>.jsonl`.

To stop: kill the background watch task.

> Distributed copy. To use `/vpin` in any project, run `npx vibepin init` (it copies
> this into `~/.claude/commands/`). Your project only needs `npm i -D vibepin`.
