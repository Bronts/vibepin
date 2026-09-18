# Antigravity (Google) integration

vibepin's core is agent-agnostic: a daemon collects annotations into `.vibepin/inbox.jsonl`
(**broadcast**) or `.vibepin/sessions/<sid>.jsonl` (**targeted at one session**), and any
agent picks them up over the **MCP** `watch_annotations` tool or a **file-watcher loop**.
Antigravity is an agentic IDE with MCP support, so MCP is the supported route here.

**Antigravity's wake path: MCP only.** There is no client process that could run (and
maintain) a parked file watcher, so Antigravity cannot use Route A — and, because of that,
its session lease is written **by the daemon**: the first tool call that carries a
`sessionId` upserts `.vibepin/sessions/<sid>.json` with `mode:"mcp"`, and a parked
`watch_annotations` keeps `lastSeenAt` at `0`. Nothing on the Antigravity side touches the
project's filesystem.

## 0. Prereqs (same for every agent)

1. Install vibepin in your project: `npm i -D vibepin`.
2. Inject the overlay in dev — Vite plugin, `withVibepin` for Next.js, or the
   standalone daemon + `<script>` tag. See the [README](../README.md) and the
   per-framework adapters.
3. Add `.vibepin/` to `.gitignore`.

## Route A — MCP (the only supported route for Antigravity)

Register vibepin's HTTP `/mcp` endpoint in Antigravity's MCP config (the
`mcpServers` object):

```json
{
  "mcpServers": {
    "vibepin": { "serverUrl": "http://127.0.0.1:7331/mcp" }
  }
}
```

> Antigravity is new and its config schema is still moving. Field names
> (`serverUrl` vs `url`) and whether HTTP is supported directly may differ from the
> snippet above — check Antigravity's current MCP docs. If only stdio is supported,
> bridge with `mcp-remote`:
> `{ "command": "npx", "args": ["-y", "mcp-remote", "http://127.0.0.1:7331/mcp"] }`.

Then ask the agent to **"start watching vibepin"**, passing a session id it will reuse:

```
watch_annotations({ sessionId: "antigravity-7d2e10" })   # that queue + the shared inbox
list_annotations({ sessionId: "antigravity-7d2e10" })
resolve_annotation({ ids: [...], sessionId: "antigravity-7d2e10" })
```

| Call | Reads | Resolves |
| --- | --- | --- |
| with `sessionId` | that session's queue **+** the shared inbox | appends `{ids, sessionId, at}` to `claims.jsonl` |
| without `sessionId` | the shared inbox **only** — identical to the old behavior | same as today, recorded append-only |

`<sid>` must match `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$` (a short `<agent>-<6hex>` like
`antigravity-7d2e10`); pick one and keep using it — that id is what the panel shows and
what a user targets. Needs `npm install` (pulls the MCP SDK).

🔴 Never use MCP's own connection-level `mcp-session-id` as the routing key — it is
connection-scoped, random, in-memory, and gone on restart/reconnect. Only the tool
argument `sessionId` is a stable route.

## Route B — file-watcher loop (not available on Antigravity today)

If Antigravity ever lets you park a shell command in a loop, the same token-cheap path other
agents use would apply:

```bash
node <vibepin>/daemon/watch.js --inbox <proj>/.vibepin/inbox.jsonl \
     --queue <proj>/.vibepin/sessions/<sid>.jsonl --session <sid> \
  && node <vibepin>/daemon/claim.js --inbox <proj>/.vibepin/inbox.jsonl \
     --queue <proj>/.vibepin/sessions/<sid>.jsonl --session <sid>
```

…but only if that shell can stay alive and write to the project. Until then, MCP is the
route.

## Which to use

- **Route A (MCP)** is the path Antigravity supports natively today, but it long-polls
  — the agent keeps spending tokens while idle.
- **Route B** would be token-cheap (the wait is in the shell) but depends on Antigravity
  being able to run a blocking command in a loop; not available today.

Both take part in session routing through the `sessionId` tool argument (Route B through
`--queue`/`--session`). Without either, you get **broadcast only** — notes the panel sent to
this session pile up in its queue instead of waking you (recover them from a shell with
`npx vibepin sessions` → `npx vibepin claim --queue .vibepin/sessions/<sid>.jsonl`).
