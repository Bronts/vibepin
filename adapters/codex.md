# Codex (OpenAI Codex CLI) integration

vibepin's core is agent-agnostic: a daemon collects annotations into `.vibepin/inbox.jsonl`
(**broadcast**) or `.vibepin/sessions/<sid>.jsonl` (**targeted at one session**), and any
agent picks them up over one of two interchangeable transports — a **token-cheap
file-watcher loop** or the **MCP** `watch_annotations` tool. Codex supports both.

**Codex's wake paths:** the file-watcher loop (a shell command that blocks, then exits) or
the MCP `watch_annotations` long-poll. Prefer the file loop — the wait happens in the shell,
not the model, so an idle session costs no tokens.

## 0. Prereqs (same for every agent)

1. Install vibepin in your project: `npm i -D vibepin`.
2. Inject the overlay in dev — Vite plugin, `withVibepin` for Next.js, or the
   standalone daemon + `<script>` tag. See the [README](../README.md) and the
   per-framework adapters.
3. Add `.vibepin/` to `.gitignore`.

## Route A — file-watcher loop (recommended, token-cheap)

```bash
npx vibepin init --agent codex      # writes ~/.codex/prompts/vpin.md
```

Then in a Codex session at your project root, run **`/vpin`**. It loops:

```bash
npx vibepin watch --queue .vibepin/sessions/<sid>.jsonl --session <sid>
# … waits (no tokens) until this session's queue OR the shared inbox changes, then:
npx vibepin claim --queue .vibepin/sessions/<sid>.jsonl --session <sid>
```

`<sid>` is a short `<agent>-<6hex>` id like `codex-9b1e04` you pick **once** and reuse on
every re-arm (the panel lists sessions by this id). `--inbox` defaults to
`./.vibepin/inbox.jsonl`, so the two flags above are enough. The claim prints this session's
queue plus the shared inbox as one de-duplicated JSON array; implement the annotations, say
what changed, then re-arm. React annotations carry the component name + `file:line`, so it
opens the correct source.

**Sandbox note:** Codex runs shell subprocesses with networking disabled
(`CODEX_SANDBOX_NETWORK_DISABLED=1`, read-only sandbox by default), so a watcher can never
heartbeat over HTTP. The file loop only writes files in the project — which is exactly why
session leases are file-based and the watcher needs no network.

## Route B — MCP

Codex's MCP servers launch over stdio, so bridge vibepin's HTTP `/mcp` with
`mcp-remote`. Add to `~/.codex/config.toml`:

```toml
[mcp_servers.vibepin]
command = "npx"
args = ["-y", "mcp-remote", "http://127.0.0.1:7331/mcp"]
```

(If your Codex build supports HTTP MCP natively, point it straight at the URL and
drop `mcp-remote`.) Then tell Codex **"start watching vibepin"**. Tools:
`watch_annotations` (long-poll), `list_annotations`, `resolve_annotation` — each takes an
optional `sessionId`:

| Call | Reads | Resolves |
| --- | --- | --- |
| `…({ sessionId: "codex-9b1e04" })` | that session's queue **+** the shared inbox | appends `{ids, sessionId, at}` to `claims.jsonl` |
| `…()` no `sessionId` | the shared inbox **only** — identical to the old behavior | same as today, recorded append-only |

🔴 Do **not** use MCP's connection-level `mcp-session-id` as the routing key — it is random,
in-memory, and dies on restart/reconnect; only the tool argument `sessionId` is stable.

## Which to use

- **Route A** is token-cheap: the wait happens in the shell, not the model, and it is the
  route that carries a stable session id for targeted delivery.
- **Route B** long-polls, so the agent keeps spending tokens while idle — fine for
  fully hands-free, worse for cost. Needs `npm install` (pulls the MCP SDK).

Both take part in session routing: Route A via `--queue`/`--session`, Route B via the
optional `sessionId` tool argument. With neither, you get **broadcast only** — notes the
panel sent to this session will pile up in its queue instead of waking you (recover them
with `npx vibepin sessions` → `npx vibepin claim --queue .vibepin/sessions/<sid>.jsonl`).
