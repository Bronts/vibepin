# omp (oh-my-pi) integration

vibepin's core is agent-agnostic: a daemon collects annotations into `.vibepin/inbox.jsonl`
(**broadcast** — every parked session in the project gets it) or into
`.vibepin/sessions/<sid>.jsonl` (**targeted** at one session). omp takes the
**file-watcher** transport — a background shell job that parks until one of those files
changes. That is the only transport that reaches a *running interactive session* without
spending tokens while nothing happens.

**omp's wake path is exactly one thing: a background job exiting.** MCP's
`watch_annotations` long-poll cannot inject a turn into a running interactive session
(next section).

## Why not MCP: the wake has to be agent-side

Three facts decide the whole integration:

1. **The page cannot reach an agent.** The overlay is a static, dependency-free script;
   all it can do is `POST` JSON to the local daemon. The daemon appends one line to the
   inbox file. Nothing on that path can start or resume a model turn.
2. **An MCP server cannot push a turn either.** MCP is client-initiated: the agent calls
   the server, never the other way round. Even `watch_annotations` is a *long-poll the
   model keeps re-issuing* — while parked there, the turn stays open and keeps spending
   tokens on an empty inbox.
3. **An interactive omp session has no external delivery entry point.** Nothing outside
   the session can inject a turn into it. The one primitive that *does* re-enter the
   conversation from outside the model is a **background job finishing**: `bash` with
   `async: true` returns immediately with a job id, and when the job exits its result is
   delivered back into the session automatically.

So the loop is: **park → wake → claim → edit → re-arm**. Park a *process*, not the
model; the process exits when an annotation arrives; omp wakes you with its output.

## 0. Prereqs (same for every agent)

1. Install vibepin in your project: `npm i -D vibepin`.
2. Inject the overlay in dev — the Vite plugin, `withVibepin` for Next.js, or the
   standalone daemon + `<script>` tag. See the [README](../README.md) and the
   per-framework adapters.
3. Add `.vibepin/` to `.gitignore` — or let `vibepin init --agent omp` do it (Route A).
4. Name the destination, so the panel says who gets the notes:

   ```js
   // vite.config.js
   import vibepin from 'vibepin/vite';
   export default defineConfig({ plugins: [react(), vibepin({ target: 'omp' })] });
   ```

   `target` is injected as `window.__vibepinTarget`; the panel's Send button then reads
   **"Send to omp"** (zh: **"发送给 omp"**) and a send reports *"Sent 2. omp will pick it
   up."*. Omit it and the overlay falls back to the generic "your agent" / "你的 agent".
   This is a **label, not a routing decision** — which session gets a note is chosen in the
   panel (see [Routing](#routing-one-queue-per-session-one-shared-inbox-for-broadcast)).

## Route A — the file-watcher loop (recommended, token-cheap)

`vibepin init --agent omp` wires this loop into the project in one command: it seeds
`.vibepin/config.json`, adds the `.vibepin/*` + `!.vibepin/config.json` `.gitignore`
rule, installs the `vibepin-annotations` skill at
`.omp/skills/vibepin-annotations/SKILL.md`, and appends a `## 注记（vibepin）` section to
`AGENTS.md` — the context file omp loads by itself — holding the exact commands below.
It is **idempotent for omp** — an existing file is reported, never rewritten (safe to
re-run) — which is precisely why an already-wired project is **not** upgraded by a re-run
when the protocol changes: pass `--upgrade` to rewrite the skill and the `AGENTS.md`
section (`config.json` is still only validated, never rewritten). It prints the plan
without writing a byte under `--dry-run`:

```bash
npx vibepin init --agent omp                                # cwd
npx vibepin init --agent omp --root ../app                  # another project
npx vibepin init --agent omp --dry-run                      # plan only
npx vibepin init --agent omp --vibepin-dir ~/src/vibepin    # point the printed commands at a checkout
npx vibepin init --agent omp --upgrade                      # rewrite SKILL.md + the AGENTS.md section
npx vibepin init --agent omp --dry-run --upgrade             # show that plan, write nothing
```

Already wired a project **before** session routing (v2 — per-session queues, `--queue`/
`--session`)? The omp branch never rewrites what exists, so it needs the explicit upgrade
(or a hand edit). See [docs/20260918-session-routing-migration.md](../docs/20260918-session-routing-migration.md).

Without init, drive it by hand: drop the three steps into the project's context file
(`AGENTS.md` / `.omp/AGENTS.md`) so every session parks the same way.

Both commands exist in two interchangeable spellings; run them **from your project
root**, because `--inbox` defaults to `./.vibepin/inbox.jsonl` **relative to cwd**.

```bash
# v2: watch this session's queue AND the shared inbox (installed as a devDependency)
npx vibepin watch --queue .vibepin/sessions/<sid>.jsonl --session <sid> && npx vibepin claim --queue .vibepin/sessions/<sid>.jsonl --session <sid>

# from a checkout
node <vibepin>/daemon/watch.js --inbox <repo>/.vibepin/inbox.jsonl --queue <repo>/.vibepin/sessions/<sid>.jsonl --session <sid> && node <vibepin>/daemon/claim.js --inbox <repo>/.vibepin/inbox.jsonl --queue <repo>/.vibepin/sessions/<sid>.jsonl --session <sid>
```

| Flag | Meaning |
| --- | --- |
| `--inbox <path>` | the **shared inbox** (broadcast). Same meaning as before; default `<cwd>/.vibepin/inbox.jsonl`. |
| `--queue <path>` | **this session's queue**. Omit it and you get the legacy behavior verbatim: broadcast only. (A bare `<sid>` is accepted as a shorthand for `<dirname(--inbox)>/sessions/<sid>.jsonl`; docs spell it as a path.) |
| `--session <sid>` | this session's id — writes/refreshes the lease `sessions/<sid>.json` and makes `claim` record `claims.jsonl`. |
| `--label <text>` / `--agent <name>` | display metadata for the panel's session list (`agent` also reads `VPIN_AGENT`). |

Sid resolution is deterministic — `--session` → `VPIN_SESSION_ID` → the queue's basename
minus `.jsonl`. A value that does not match `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$` exits 1
without writing anything. `<sid>` looks like `omp-2f9c1a`; pick one per session and
**reuse it on every re-arm** — the panel lists sessions by this id, and a different id each
round leaves orphan rows (and nothing for the user to target).

### 1. Park — one omp background job

```
node <vibepin>/daemon/watch.js --inbox <repo>/.vibepin/inbox.jsonl \
     --queue <repo>/.vibepin/sessions/<sid>.jsonl --session <sid>
```

(Drop `--queue`/`--session` and you get the legacy broadcast-only loop — see
[Routing](#routing-one-queue-per-session-one-shared-inbox-for-broadcast).)

Launch it as an omp background job (`async: true`; add `timeout: 0` so the 300 s default
deadline doesn't kill the park). It prints one line per watched file and blocks:

```
[vibepin] watching /abs/path/.vibepin/inbox.jsonl (from 0 bytes) …
[vibepin] watching /abs/path/.vibepin/sessions/omp-2f9c1a.jsonl (0 pending) …
[vibepin] session omp-2f9c1a (lease /abs/path/.vibepin/sessions/omp-2f9c1a.json) …
```

Each watched file gets its own baseline (`{size, mtimeMs, ino}`) and **any** difference
wakes it: growth, shrinking (after a claim), a replaced file (new inode), a bare touch. A
queue that already has unclaimed lines makes it exit **immediately** instead of parking
(wake reason `queue already has 2 pending`) — a batch that arrived while nothing was
watching is drained right away.

### 2. Wake — the job exiting is the wake

```
[vibepin] wake: /abs/path/.vibepin/inbox.jsonl changed (0B mtime=1758182462000 ino=123456 → 143B mtime=1758182469987 ino=123456)
```

`watch.js` exits 0 as soon as **any** watched file differs from its baseline (size, mtime,
or inode) — the reason names the file and the before/after values. omp delivers that job
output back into the session, which is what re-invokes you.

**No model tokens are spent while it blocks** — the wait lives in a shell process.
Optional safety net: `ANNOTATE_WATCH_TIMEOUT=600000` bounds the park to 10 minutes
(exit 0, `[vibepin] wake: timeout after 600000ms (re-arm)`) instead of parking forever.
A file that cannot be stat'ed is **not** silently treated as empty: the watcher prints
`[vibepin] cannot stat <file>: <CODE>` on stderr and exits 2, so the failed job surfaces
in your turn instead of parking forever.

### 3. Claim — once per wake

```
node <vibepin>/daemon/claim.js --inbox <repo>/.vibepin/inbox.jsonl --queue <repo>/.vibepin/sessions/<sid>.jsonl --session <sid>
```

Each file is handled **independently**: rename `<file>` → `<file>.claiming` (so concurrent
`POST`s start a fresh file), then append the claimed lines to `processed.jsonl` **next to
the shared inbox** (the audit trail — there is no separate resolve step; the archive dir is
always `dirname(--inbox)`, never the queue's dir). Output is one JSON array: this session's
queue first, then the shared inbox, de-duplicated by `id`. A missing file simply contributes
nothing, `[]` means nothing was pending (already taken, or only broadcast notes went
elsewhere), and a non-ENOENT failure exits 1 with a one-line diagnosis. `--session` (or a
queue basename) also appends `{ids, sessionId, at}` to `claims.jsonl` — that is what the
panel's "last claim" line reads.

If a previous claim crashed between the rename and the archive, the next `claim` **recovers
the orphan `.claiming` batch first**: it is archived to `processed.jsonl`, printed as the
batch, with a warning on stderr. `claim --recover` does only that recovery pass and does
**not** drain live queues.

### 4. Edit

Each item is one note; `kind` tells you how to find the source:

- `kind: "element"` → prefer `component` + `source` (React/Vue dev builds give
  `<Hero> /src/components/Hero.jsx:12`); otherwise fall back to `selector` / `html` /
  `styles`.
- `kind: "region"` → `rect` plus `elements` (the components sampled inside the box).

Each item also carries `inbox`, `projectRoot` and `daemonPort`, stamped by the **daemon**
(never by the page). Check they match the project you are editing before you touch a
file — that is the ground truth for "where did this come from". A claimed item looks
like this (paths shortened):

```json
[
  {
    "id": "1789527553482-0",
    "ts": 1789527553482,
    "url": "http://localhost:5173/",
    "note": "make the CTA bigger",
    "kind": "element",
    "selector": "button#cta",
    "component": "Hero",
    "source": "/src/components/Hero.jsx:12",
    "elements": null,
    "rect": null,
    "html": "",
    "styles": null,
    "screenshot": null,
    "inbox": "/abs/path/.vibepin/inbox.jsonl",
    "projectRoot": "/abs/path",
    "daemonPort": 7331
  }
]
```

Then say briefly what changed and in which files.

### 5. Re-arm

Go back to step 1 — **after** the claim, never before (next section).

### The trap: exactly one claim per wake, and the re-arm comes last

`watch.js` is a file-change detector, not a parser: it snapshots every watched file
(`{size, mtimeMs, ino}`) and fires on any difference — it cannot tell "new note" from
"someone emptied the file". That makes the order non-negotiable: **park → wake → claim →
edit → park**. (v2's multi-signal baseline makes a wrong order *self-healing* instead of
permanently blinding, but it is still the wrong order.)

| Wrong order | What actually happens |
| --- | --- |
| Wake, then re-arm **without claiming** | The next baseline includes the un-drained notes, so the watcher sits still on work you never took. The next change then returns **both** the old id (already announced) and the new one — and you re-do finished work. |
| Re-arm **before** claiming | The claim itself is a change (the file shrinks / is replaced), so the fresh watcher fires **immediately** on it — a spurious wake whose only batch is `[]` (or the next real batch, if it lands in the same instant). Noisy, no longer silent, still wrong. |
| A second `claim` in the same round | Prints `[]`. Harmless by itself, but it means the round is over; don't re-arm expecting that batch. |

If you suspect a missed round, just run one `claim` by hand: whatever is in the inbox is
returned, and `processed.jsonl` shows what was already archived.

### omp shortcut: park and drain as one job

Because `watch` exits 0 before `claim` runs, a single background job can do both — and
then the *delivered result already is the batch*, so the wake cannot be forgotten:

```
node <vibepin>/daemon/watch.js --inbox <repo>/.vibepin/inbox.jsonl \
     --queue <repo>/.vibepin/sessions/<sid>.jsonl --session <sid> \
  && node <vibepin>/daemon/claim.js --inbox <repo>/.vibepin/inbox.jsonl \
     --queue <repo>/.vibepin/sessions/<sid>.jsonl --session <sid>
```

Its output looks like this:

```
[vibepin] watching /abs/path/.vibepin/inbox.jsonl (from 0 bytes) …
[vibepin] watching /abs/path/.vibepin/sessions/omp-2f9c1a.jsonl (0 pending) …
[vibepin] session omp-2f9c1a (lease /abs/path/.vibepin/sessions/omp-2f9c1a.json) …
[vibepin] wake: /abs/path/.vibepin/sessions/omp-2f9c1a.jsonl changed (0B mtime=1758182462000 ino=123456 → 80B mtime=1758182489512 ino=123456)
[
  {
    "id": "f1",
    "note": "sent while parked",
    "kind": "element",
    "selector": "h1"
  }
]
```

One caveat: with `&&` you cannot inspect the batch *between* the wake and the drain. If
you want that control (`ANNOTATE_WATCH_TIMEOUT`, a manual review of the ids), use the two
separate steps.

## Routing: one queue per session, one shared inbox for broadcast

There are exactly two delivery classes, and **the overlay is the only place that decides
which one a note gets** — the daemon never guesses:

1. **Broadcast** — the note has no explicit target, so it lands in the shared
   `.vibepin/inbox.jsonl`. Every parked session in the project wakes for it (this is what
   omp's legacy `--inbox`-only loop has always done).
2. **Targeted** — the note carries an explicit `targetSession` (the panel pre-fills it when
   exactly one session is parked, and lists candidates when there are more), so it lands
   **only** in `.vibepin/sessions/<sid>.jsonl`. No copy is written to the shared inbox, and
   no other session is woken. If the target has no lease file any more, the daemon degrades
   to broadcast and says so (`routed:"broadcast", degraded:true`).

**Liveness never decides delivery.** A lease's age only changes what the panel prints
("last active N minutes ago"); a session that has not heartbeat for an hour still receives
targeted notes — it just may not be watching. That is deliberate: a stale guess must never
be able to misroute.

- **One daemon, one inbox, per project.** The Vite adapter picks port `7331` when free,
  otherwise the first free port in `7332–7370`, spawns the daemon with
  `--inbox <root>/.vibepin/inbox.jsonl --root <root>`, and injects
  `<script src="http://127.0.0.1:<port>/annotate.js">`. A probe is a hint, not a
  reservation — two dev servers can start at once — so the spawn is **confirmed against
  `/health`** before any HTML is served; if another project's daemon won the race, the
  adapter says `[vibepin] port 7332 was taken while starting — trying the next free one`
  and comes up on the next free port instead. The overlay posts to the origin it was
  loaded from, so a page can only ever write into the project whose inbox its port serves
  — two projects on one machine cannot cross-deliver.
- **No silent misroute.** If a daemon finds its port already taken it asks that port for
  `/health`. Same inbox → `[vibepin] daemon already running on 127.0.0.1:7331 for this
  inbox — reusing it` and exit 0. A *different* inbox → it refuses and exits 1, printing
  both paths:

  ```
  [vibepin] FATAL 127.0.0.1:7331 already serves a different project.
  [vibepin]   its inbox:  /abs/other-project/.vibepin/inbox.jsonl
  [vibepin]   this inbox: /abs/this-project/.vibepin/inbox.jsonl
  [vibepin] Refusing to start: annotations from this project would be delivered elsewhere.
  ```

- **A queue has exactly one reader; the shared inbox is still first-come-first-served.**
  Broadcast notes go to whoever claims them first (one atomic rename), which is why two
  sessions parked on the same inbox still race for them — **if you need a specific session
  to get it, target that session.** Within one session, keep exactly one parked watcher per
  queue (`sessions/<sid>.jsonl` has one writer, so two watchers on it would steal from each
  other).
- **Know which mailbox you are watching.** Run the commands from the project root, or
  pass the absolute `--inbox` the daemon printed at startup
  (`[vibepin] inbox <abs path>`). To confirm from anywhere:

  ```bash
  curl http://127.0.0.1:7331/health
  {"ok":true,"inbox":"/abs/path/.vibepin/inbox.jsonl","pending":0,"port":7331,"projectRoot":"/abs/path","sessions":1,"pendingTotal":0}
  curl http://127.0.0.1:7331/sessions
  {"sessions":[{"sessionId":"omp-2f9c1a","agent":"omp","label":"","lastSeenAt":12,"pending":2,"mode":"file"}]}
  ```

  `pending` is the **shared inbox** count (unchanged meaning); `pendingTotal` adds every
  session queue, so check that one if you have more than one session — `pending` alone
  under-reports. `/sessions` is the read-only registry (derived from the lease files on
  disk); it deliberately never returns `cwd`, `pid`, or absolute paths.
- **If a targeted note never woke anyone** (the session was running a legacy
  `--inbox`-only loop, or its watcher died), the note is still on disk. Recover it with
  `npx vibepin sessions` (lists `sid · agent · label · last activity · pending`) and
  `npx vibepin claim --queue .vibepin/sessions/<sid>.jsonl`. The full upgrade procedure is
  in [docs/20260918-session-routing-migration.md](../docs/20260918-session-routing-migration.md).

## Config reference

```js
// vite.config.js
vibepin({
  target: 'omp',                                   // panel says "Send to omp"; '' = generic phrase
  // port: 7334,                                   // pin the daemon port (explicit wins, no probing)
  // inbox: '../shared/.vibepin/inbox.jsonl',      // any path; the injected <script src> follows the port
})
```

| Option | Default | Effect |
| --- | --- | --- |
| `target` | `''` | `window.__vibepinTarget` — the display name shown as the destination ("Send to omp"). **Display only**: it is not a routing key (per-session targeting is chosen in the panel). |
| `port` | auto | Explicit port is used as-is — no probing, and no retry if another project owns it (the dev-server start aborts). Otherwise `7331`, else the first free one up to `7370`. |
| `inbox` | `<root>/.vibepin/inbox.jsonl` | Where annotations land; the isolated mailbox for this project. |
| `enabled` | `true` (dev only) | Set `false` to disable the plugin entirely. |

Standalone daemon (no Vite): `node <vibepin>/daemon/daemon.js --port 7332 --inbox
<path> --root <project>` — then park on that same `--inbox`.

## Troubleshooting

- *"I parked and nothing ever woke me."* First: did you pass `--queue`? Without it you get
  **broadcast only** — targeted notes pile up in `sessions/<sid>.jsonl` and nothing wakes
  you. Recover them with `npx vibepin sessions` (sid · agent · label · last activity ·
  pending) and `npx vibepin claim --queue .vibepin/sessions/<sid>.jsonl`. Otherwise check
  the watcher's first lines: it must be armed on the same files you claim, and each line
  prints its baseline (`(from N bytes)` / `(N pending)`). If a failed `stat` was involved
  you will see `[vibepin] cannot stat <file>: <CODE>` and exit code 2 — that is a failed
  job, not an empty queue. Passing a **directory** where a file is expected (`--inbox
  .vibepin`) is refused up front — `… is not a file — it is a directory; pass the
  inbox/queue path, e.g. <proj>/.vibepin/inbox.jsonl, exit 1` — with nothing moved on disk.
- *Daemon banner says* "MCP off — run `npm install` in vibepin to enable /mcp": the MCP
  SDK isn't installed (a bare checkout), so only Route B is unavailable. Route A needs no
  SDK.
- *FATAL in the dev log.* `FATAL … already serves a different project.` **followed by**
  `[vibepin] port 7332 was taken while starting — trying the next free one` is benign: two
  dev servers started at the same moment and this one retries the next free port. FATAL
  *without* the retry line — and the dev server aborting with `[vibepin] could not start a
  daemon for <inbox> (tried up to port N) — see the daemon output above` — means the port
  was pinned with `{ port }` (explicit ports never retry) or is held by something other
  than a vibepin daemon. Stop the holder, or drop the explicit `port`.

## Route B — MCP (fallback: hands-free, but idle tokens)

omp reads MCP servers from its native config. vibepin's daemon exposes Streamable HTTP
at `/mcp`, on the **same port as the project's daemon**:

```json
// .omp/mcp.json
{
  "mcpServers": {
    "vibepin": { "type": "http", "url": "http://127.0.0.1:7331/mcp" }
  }
}
```

Tools: `watch_annotations` (long-poll, 25 s default — returns `[]` on timeout, call again
to keep watching), `list_annotations` (peek without draining), `resolve_annotation` (mark
ids done → appended to `claims.jsonl`). Then tell omp **"watch vibepin annotations"**.

All three take an optional `sessionId`, so MCP sessions take part in routing too:

| Call | Reads | Resolves |
| --- | --- | --- |
| `…({ sessionId: "omp-2f9c1a" })` | that session's queue **+** the shared inbox | appends one line to `claims.jsonl` (`{ids, sessionId, at}`); never rewrites a queue file |
| `…()` with no `sessionId` | the shared inbox **only** — byte-for-byte today's behavior | same as today, but recorded append-only |

The lease for an MCP session is written **by the daemon** (`mode:"mcp"`), not by the
client — so a setup with no client process (Antigravity) still appears in `GET /sessions`,
and a parked long-poll shows `lastSeenAt: 0`.

🔴 **Never use MCP's own connection-level `mcp-session-id` as the routing key.** It is
generated per connection with `randomUUID()`, lives in daemon memory, and is deleted on
close — a daemon restart or client reconnect silently invalidates any target bound to it.
The routing key is only ever the **tool argument** `sessionId`.

## Which to use

- **Route A** is the recommended path on omp: the wait happens in a background shell job,
  so an idle session costs nothing, and the job's completion is the only wake primitive
  omp can actually deliver into a running session. It is also the route with a stable,
  targetable session id (`--queue`/`--session`).
- **Route B** long-polls from inside the model, so it keeps spending tokens while the
  inbox is empty — fine for fully hands-free, worse for cost.

Both take part in session routing — Route A through `--queue`/`--session`, Route B through
the optional `sessionId` tool argument. With neither, you are on the shared inbox and get
**broadcast only**.
