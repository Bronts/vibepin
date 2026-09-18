// MCP tool routing (§7.4 pending counts + §8.2 optional sessionId).
//
//   node --test daemon/mcp.sessions.test.mjs      (or: node --test daemon/)
//
// Two things make this drivable without @modelcontextprotocol/sdk installed:
// `createToolBindings` is exported for exactly this purpose, and daemon.js exports
// the `sessions` registry whose snapshot GET /sessions serves — so the calls below
// run against the real store, the real atomic lease writer and the real snapshot,
// not stand-ins. An import opens no listener, nothing here touches a real
// project's .vibepin/, and no port is bound.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createStore } from './store.js';
import { createToolBindings } from './mcp.js';

const DAEMON = resolve(dirname(fileURLToPath(import.meta.url)), 'daemon.js');
const FIELDS = ['agent', 'label', 'lastSeenAt', 'mode', 'pending', 'sessionId'];

let root, inbox, sessionsDir, store, sessions, tools;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what, fn, timeoutMs = 6000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const got = await fn();
    if (got) return got;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(120);
  }
}

// What GET /sessions serves: the rows of the shared snapshot (§4.4). In a real
// daemon the MCP handler and the HTTP views live in the same process, so this is
// the very table a browser would read.
const row = (sid) => sessions.snapshot().sessions.find((s) => s.sessionId === sid);

// A park resolves immediately when its read set is already non-empty, so a test
// that wants to prove what *wakes* a park has to start from a drained inbox.
const drainInbox = async () => tools.resolve({ ids: (await tools.list()).map((i) => i.id) });

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'vpin-s2-mcp-'));
  inbox = join(root, '.vibepin', 'inbox.jsonl');
  sessionsDir = join(root, '.vibepin', 'sessions');
  await mkdir(sessionsDir, { recursive: true });

  // daemon.js resolves its inbox and config at import time: pin the inbox through
  // the env var it honours, and point --config at a file that does not exist so
  // the module cannot pick up whatever .vibepin/config.json the cwd happens to own.
  process.env.ANNOTATE_INBOX = inbox;
  process.argv.push('--config', join(root, 'no-config.json'));
  const daemon = await import(pathToFileURL(DAEMON).href);
  sessions = daemon.sessions;   // the instance the HTTP views serve
  sessions.start();             // started here: an import opens no listener to start it
  store = createStore(inbox);
  tools = createToolBindings(store, sessions);
});

after(async () => {
  delete process.env.ANNOTATE_INBOX;
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// ---------------------------------------------------------------------------

test('two sessionIds on one connection each read only their own queue', async () => {
  // The touch: a tool call with a sessionId is what registers the lease (§8.2).
  await tools.list({ sessionId: 'mcp-aaa111' });
  await tools.list({ sessionId: 'mcp-bbb222' });
  await store.append([{ id: 'a1', note: 'only A' }], { sid: 'mcp-aaa111' });
  await store.append([{ id: 'b1', note: 'only B' }], { sid: 'mcp-bbb222' });
  await store.append([{ id: 'bc1', note: 'everyone' }]);

  const a = await tools.list({ sessionId: 'mcp-aaa111' });
  const b = await tools.list({ sessionId: 'mcp-bbb222' });
  const legacy = await tools.list();

  // Own queue first, then the shared inbox: the read set of `watch --queue` +
  // `--inbox`, so a targeted note and a broadcast both arrive — and nothing else.
  assert.deepEqual(a.map((i) => i.id), ['a1', 'bc1']);
  assert.deepEqual(b.map((i) => i.id), ['b1', 'bc1']);
  assert.ok(!a.some((i) => i.id === 'b1') && !b.some((i) => i.id === 'a1'), 'the two sessions must not see each other');
  // No sessionId ⇒ shared inbox only, i.e. exactly what the tools did before.
  assert.deepEqual(legacy.map((i) => i.id), ['bc1']);
});

test('resolve is append-only and reports a line count, not a byte count', async () => {
  const queueA = join(sessionsDir, 'mcp-aaa111.jsonl');
  await store.append([{ id: 'fat', note: 'x'.repeat(4000) }], { sid: 'mcp-aaa111' });
  const queueBytes = statSync(queueA).size;
  assert.ok(queueBytes > 4000, `the fixture must be fat enough for bytes ≠ lines, got ${queueBytes}`);

  const receipt = await tools.resolve({ ids: ['fat'], sessionId: 'mcp-aaa111' });
  // §7.4: the old receipt was store.size() — bytes. Here A's queue still holds the
  // unclaimed a1 and the shared inbox holds bc1 ⇒ 2 annotations, whatever they weigh.
  assert.deepEqual(receipt, { resolved: 1, pending: 2 });

  // Append-only (§7.3): the claimed line is still in the queue, only claims.jsonl
  // grew — a read-modify-write window is what used to erase concurrent POSTs.
  assert.ok((await readFile(queueA, 'utf8')).includes('"fat"'), 'resolve must not rewrite a queue');
  const claims = await readFile(join(root, '.vibepin', 'claims.jsonl'), 'utf8');
  assert.match(claims, /"sessionId":"mcp-aaa111"/, 'the claim is accounted for against the session');

  // Idempotent, and it can only resolve ids that are in its own read set.
  assert.deepEqual(await tools.resolve({ ids: ['fat'], sessionId: 'mcp-aaa111' }), { resolved: 0, pending: 2 });
  assert.deepEqual(await tools.resolve({ ids: ['a1'], sessionId: 'mcp-bbb222' }), { resolved: 0, pending: 2 });
  assert.deepEqual((await tools.list({ sessionId: 'mcp-aaa111' })).map((i) => i.id), ['a1', 'bc1']);
});

test('without a sessionId the long-poll ignores session queues, as before', async () => {
  await drainInbox();
  const parked = tools.watch({ timeoutMs: 3000 });
  let woken = null;
  parked.then((v) => { woken = v; }, () => {});
  await sleep(300);
  // A targeted note must not wake a legacy caller: it is not in its read set, and
  // waking it would burn an agent turn (§4.5 rule 1).
  await store.append([{ id: 'q-only', note: 'targeted' }], { sid: 'mcp-aaa111' });
  await sleep(700);
  assert.equal(woken, null, 'a session queue must not wake a no-sessionId watch');

  await store.append([{ id: 'bc2', note: 'broadcast' }]);
  const items = await parked;
  assert.deepEqual(items.map((i) => i.id), ['bc2'], 'a broadcast does wake it, and only it');
  assert.ok(!items.some((i) => i.id === 'q-only'), 'a targeted note stays invisible to it');
});

test('an invalid sessionId is refused before anything is written', async () => {
  const before = (await readdir(sessionsDir)).sort();
  for (const sessionId of ['../../evil', '..', 'a/b', 'a\\b', '.hidden', '-lead', 'x'.repeat(65), 42]) {
    await assert.rejects(() => tools.list({ sessionId }), /bad sessionId/, `${JSON.stringify(sessionId)} must be refused`);
  }
  assert.deepEqual((await readdir(sessionsDir)).sort(), before, 'no lease and no queue may be created');
  assert.equal(existsSync(join(sessionsDir, 'evil.json')), false);
});

test('a tool call upserts the lease, and a parked session reads as alive', async () => {
  await drainInbox();
  const sid = 'mcp-park01';
  await tools.list({ sessionId: sid });

  const leaseFile = join(sessionsDir, `${sid}.json`);
  const lease = JSON.parse(await readFile(leaseFile, 'utf8'));
  // §8.2: the daemon is the writer for MCP sessions — an MCP client has no process
  // to write a lease with (Antigravity) and no network to send a heartbeat from
  // (Codex's shell is sandboxed), so a tool call is the heartbeat.
  assert.equal(lease.mode, 'mcp');
  assert.equal(lease.agent, 'mcp');
  assert.equal(lease.cwd, undefined, 'the daemon never invents a cwd for a session');
  assert.equal(lease.pid, undefined);
  assert.equal(typeof lease.startedAt, 'string');

  const fresh = await waitFor('the snapshot to hold the new session', async () => row(sid));
  assert.deepEqual(Object.keys(fresh).sort(), FIELDS, 'same whitelist as GET /sessions');
  assert.equal(fresh.mode, 'mcp');
  assert.equal(fresh.agent, 'mcp');
  assert.equal(fresh.lastSeenAt, 0);
  assert.equal(fresh.pending, 0);

  // Park the long-poll, then make the lease look an hour old — the disk state a
  // session really has while it sits in a long park (§6.1: the call that opened
  // the park is long past).
  const parked = tools.watch({ sessionId: sid, timeoutMs: 5200 });
  await sleep(400);                                   // past touch(): the park is open
  const old = Date.now() - 3600_000;
  await writeFile(leaseFile, JSON.stringify({ ...lease, lastReArmAt: old }) + '\n', 'utf8');
  utimesSync(leaseFile, new Date(old), new Date(old));

  // A second lease forces a refresh that has definitely re-read the sessions dir
  // *after* the ageing above, so the 0 below cannot be a stale pre-ageing row.
  await sessions.writeLease('mcp-tick01', { agent: 'probe', mode: 'file' });
  assert.equal(sessions.snapshot().sessions.length, 4);
  assert.equal(row(sid).lastSeenAt, 0, 'parked is the most accurate liveness signal there is (§8.2)');

  assert.deepEqual(await parked, [], 'the parked call returns [] on timeout so the client loops');
  await waitFor('the aged lease to read as stale once the park is over', async () => {
    const after = row(sid);
    return after && after.lastSeenAt >= 900 ? after : null;
  });
});
