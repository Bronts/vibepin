# Cursor integration

vibepin's core is agent-agnostic: a daemon collects annotations into `.vibepin/inbox.jsonl`
(**broadcast**) or `.vibepin/sessions/<sid>.jsonl` (**targeted at one session**), and any
agent picks them up over one of two interchangeable transports — a **token-cheap
file-watcher loop** or the **MCP** `watch_annotations` tool. Cursor supports both, and its
native HTTP MCP makes Route B especially clean.

**Cursor's wake paths:** the terminal file-watcher loop (blocks, then exits) or the MCP
`watch_annotations` long-poll. Prefer the file loop — the wait happens in the terminal, not
the model.

## 0. Prereqs (same for every agent)

1. Install vibepin in your project: `npm i -D vibepin`.
2. Inject the overlay in dev — Vite plugin, `withVibepin` for Next.js, or the
   standalone daemon + `<script>` tag. See the [README](../README.md) and the
   per-framework adapters.
3. Add `.vibepin/` to `.gitignore`.

## Route A — file-watcher loop (recommended, token-cheap)

Cursor's custom commands are project-scoped, so run this **in your project root**:

```bash
npx vibepin init --agent cursor     # writes .cursor/commands/vpin.md
```

Then in Cursor's Agent, run **`/vpin`**. It loops:

```bash
npx vibepin watch --queue .vibepin/sessions/<sid>.jsonl --session <sid>
# … waits (no tokens) until this session's queue OR the shared inbox changes, then:
npx vibepin claim --queue .vibepin/sessions/<sid>.jsonl --session <sid>
```

`<sid>` is a short `<agent>-<6hex>` id like `cursor-4c8d31` you pick **once** and reuse on
every re-arm. `--inbox` defaults to `./.vibepin/inbox.jsonl`, so the two flags above are
enough. The claim prints this session's queue plus the shared inbox as one de-duplicated
JSON array; implement the annotations, say what changed, then re-arm. React annotations
carry the component name + `file:line`.

## Route B — MCP (native HTTP)

Add to `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "vibepin": { "url": "http://127.0.0.1:7331/mcp" }
  }
}
```

Settings → MCP should show **vibepin** green. Then tell the Agent **"watch vibepin
annotations"**. Tools: `watch_annotations` (long-poll), `list_annotations`,
`resolve_annotation` — each takes an optional `sessionId`:

| Call | Reads | Resolves |
| --- | --- | --- |
| `…({ sessionId: "cursor-4c8d31" })` | that session's queue **+** the shared inbox | appends `{ids, sessionId, at}` to `claims.jsonl` |
| `…()` no `sessionId` | the shared inbox **only** — identical to the old behavior | same as today, recorded append-only |

🔴 Do **not** use MCP's connection-level `mcp-session-id` as the routing key — it is random,
in-memory, and dies on restart/reconnect; only the tool argument `sessionId` is stable.

## Which to use

- **Route A** is token-cheap: the wait happens in the terminal, not the model, and it
  carries a stable session id for targeted delivery.
- **Route B** long-polls, so the agent keeps spending tokens while idle — fine for
  fully hands-free, worse for cost. Needs `npm install` (pulls the MCP SDK).

Both take part in session routing: Route A via `--queue`/`--session`, Route B via the
optional `sessionId` tool argument. With neither, you get **broadcast only** — notes the
panel sent to this session will pile up in its queue instead of waking you (recover them
with `npx vibepin sessions` → `npx vibepin claim --queue .vibepin/sessions/<sid>.jsonl`).
