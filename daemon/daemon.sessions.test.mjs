// Session routing over HTTP (§4.4 read-only views + §4.5 write rules).
//
// Runs the real daemon CLI in a throwaway project directory — the same way the
// Vite plugin spawns it — and talks to it with fetch. Zero deps; nothing here
// touches a real project's .vibepin/, and no daemon that is already running is
// disturbed (an OS-assigned port is used, never 7331).
//
//   node daemon/daemon.sessions.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync, utimesSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DAEMON = resolve(dirname(fileURLToPath(import.meta.url)), 'daemon.js');
const FIELDS = ['agent', 'label', 'lastSeenAt', 'mode', 'pending', 'sessionId'];

let root, inbox, sessionsDir, child, base;

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

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

const get = async (path) => {
  const res = await fetch(base + path, { cache: 'no-store' });
  return { status: res.status, body: await res.json() };
};
const post = async (payload) => {
  const res = await fetch(`${base}/annotations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
};

const readLines = async (file) => {
  try {
    return (await readFile(file, 'utf8')).split('\n').filter(Boolean);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
};

const lease = (sid, extra = {}) => writeFile(join(sessionsDir, `${sid}.json`), JSON.stringify({
  agent: sid.split('-')[0], label: `work on ${sid}`, pid: 4242, watcherPid: 4243,
  cwd: root, mode: 'file', startedAt: '2026-09-18T10:00:00Z', ...extra,
}) + '\n', 'utf8');

// Two hours old: definitely "stale" by §6.3's STALE_AFTER (900s). A stale target
// still owns its queue — liveness never decides delivery (§1.4 invariant 3).
const stale = (sid) => {
  const when = new Date(Date.now() - 2 * 3600 * 1000);
  utimesSync(join(sessionsDir, `${sid}.json`), when, when);
};

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'vpin-s2-http-'));
  inbox = join(root, '.vibepin', 'inbox.jsonl');
  sessionsDir = join(root, '.vibepin', 'sessions');
  await mkdir(sessionsDir, { recursive: true });
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, ANNOTATE_DEBUG: '1' };
  delete env.ANNOTATE_INBOX;
  delete env.ANNOTATE_PORT;
  delete env.ANNOTATE_ROOT;
  child = spawn(process.execPath, [DAEMON, '--inbox', inbox, '--root', root, '--port', String(port)], { cwd: root, env });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  await waitFor('the daemon banner', () => out.includes(`http://127.0.0.1:${port}`), 10000);
});

after(async () => {
  if (child && child.exitCode === null) {
    // Windows will not remove a directory a live process still holds open, so the
    // child has to be gone before rm() — otherwise teardown fails the run instead
    // of the tests.
    const gone = new Promise((r) => child.once('exit', r));
    child.kill();
    await gone;
  }
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// ---------------------------------------------------------------------------

test('/health keeps the discovery fields and adds the session counts', async () => {
  const { status, body } = await get('/health');
  assert.equal(status, 200);
  // extension/discover.js:37 — a daemon is recognised by exactly these two.
  assert.equal(typeof body.inbox, 'string');
  assert.ok(body.inbox);
  assert.ok(Number.isFinite(body.port));
  assert.equal(resolve(body.inbox).toLowerCase(), resolve(inbox).toLowerCase());
  // §4.4 additions, both numbers, plus `pending` staying a number.
  assert.equal(typeof body.pending, 'number');
  assert.ok(Number.isFinite(body.sessions));
  assert.ok(Number.isFinite(body.pendingTotal));
});

test('GET /sessions exposes the whitelist only, sorted by freshness', async () => {
  await lease('omp-aaa111');
  await lease('codex-bbb222');
  stale('codex-bbb222');
  // omp's queue: two lines, one of them already claimed ⇒ pending 1 (§4.4).
  await writeFile(join(sessionsDir, 'omp-aaa111.jsonl'), [
    JSON.stringify({ id: 'q1', note: 'first' }),
    JSON.stringify({ id: 'q2', note: 'second' }),
  ].join('\n') + '\n', 'utf8');
  await writeFile(join(root, '.vibepin', 'claims.jsonl'), JSON.stringify({ ids: ['q1'], sessionId: 'omp-aaa111', at: 1758182462000 }) + '\n', 'utf8');
  // Decoys: an invalid sid and the reserved .token must never become sessions.
  await writeFile(join(sessionsDir, '..json'), '{}\n', 'utf8');
  await writeFile(join(sessionsDir, '.token'), 'secret\n', 'utf8');

  const snap = await waitFor('two sessions', async () => {
    const { body } = await get('/sessions');
    return body.sessions.length === 2 ? body : null;
  });

  for (const row of snap.sessions) {
    assert.deepEqual(Object.keys(row).sort(), FIELDS, 'only whitelisted fields may be returned');
  }
  // §4.4: ascending by lastSeenAt, i.e. the freshest session first — a stale
  // target is *labelled* last, never dropped and never routed around.
  assert.deepEqual(snap.sessions.map((s) => s.sessionId), ['omp-aaa111', 'codex-bbb222']);
  const [omp, codex] = snap.sessions;
  assert.equal(codex.agent, 'codex');
  assert.equal(codex.label, 'work on codex-bbb222');
  assert.equal(codex.mode, 'file');
  assert.ok(codex.lastSeenAt >= 7100, `stale session reports ~2h, got ${codex.lastSeenAt}`);
  assert.equal(codex.pending, 0);
  assert.equal(omp.lastSeenAt, 0);
  assert.equal(omp.pending, 1, 'pending counts unclaimed lines, not bytes');
  // Newest claim line, metadata only.
  assert.deepEqual(snap.lastClaim, { sessionId: 'omp-aaa111', at: 1758182462000, count: 1 });

  // The raw payload must not carry anything about the machine or the project.
  const raw = JSON.stringify(snap);
  for (const leak of ['cwd', 'pid', 'watcherPid', '.jsonl', '.vibepin', root, 'sessions/']) {
    assert.ok(!raw.includes(leak), `GET /sessions leaked ${leak}: ${raw}`);
  }
});

test('POST without targetSession is exactly the old broadcast', async () => {
  const before = await readLines(inbox);
  const audit = join(root, '.vibepin', 'routed.jsonl');
  const auditBefore = existsSync(audit) ? (await readFile(audit, 'utf8')) : '';

  // A deliberately fat note: `pending` must be the number of annotations, so a
  // byte count (the pre-§7.4 meaning) cannot pass this assertion by accident.
  const { status, body } = await post([{ id: 'b1', note: 'broadcast me '.repeat(200), selector: '#a' }]);
  assert.equal(status, 200);
  assert.deepEqual(body, { ok: true, received: 1, routed: 'broadcast', pending: before.length + 1 });
  assert.equal(body.degraded, undefined);
  assert.equal(body.target, undefined);

  const after = await readLines(inbox);
  assert.equal(after.length, before.length + 1);
  assert.equal(JSON.parse(after.at(-1)).id, 'b1');
  // No target ⇒ no routing record (the audit exists for degradation + targeting).
  assert.equal(existsSync(audit) ? await readFile(audit, 'utf8') : '', auditBefore);
});

test('a targeted note with a lease goes to that queue and nowhere else', async () => {
  const inboxBefore = await readLines(inbox);
  const queue = join(sessionsDir, 'omp-aaa111.jsonl');
  const queueBefore = await readLines(queue);

  // The array form carries the target beside the batch, exactly as the overlay
  // posts it — and targetSession must not survive into the stored annotation.
  const { status, body } = await post({ annotations: [{ id: 't1', note: 'only for omp', selector: '#x' }], targetSession: 'omp-aaa111' });
  assert.equal(status, 200);
  assert.deepEqual(body, { ok: true, received: 1, routed: 'session', pending: 2, target: 'omp-aaa111' });
  assert.equal(body.degraded, undefined);

  const inboxAfter = await readLines(inbox);
  assert.deepEqual(inboxAfter, inboxBefore, 'a targeted note must not leave a shadow copy in the shared inbox');
  const queueAfter = await readLines(queue);
  assert.equal(queueAfter.length, queueBefore.length + 1);
  const stored = JSON.parse(queueAfter.at(-1));
  assert.equal(stored.id, 't1');
  assert.equal(stored.note, 'only for omp');
  assert.equal(stored.targetSession, undefined, 'the routing key is not an annotation field');
  assert.equal(resolve(stored.inbox).toLowerCase(), resolve(inbox).toLowerCase(), 'provenance still stamped by the daemon');

  const audit = (await readFile(join(root, '.vibepin', 'routed.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  const rec = audit.at(-1);
  assert.deepEqual(rec, { at: rec.at, target: 'omp-aaa111', routed: 'session', degraded: false, reason: null, received: 1, ids: ['t1'], url: '' });
  assert.ok(!JSON.stringify(rec).includes('only for omp'), 'the audit carries metadata, never the note body');
});

test('a stale target still gets its own queue (liveness does not route)', async () => {
  const inboxBefore = await readLines(inbox);
  const { status, body } = await post({ annotations: [{ id: 's1', note: 'stale but mine' }], targetSession: 'codex-bbb222' });
  assert.equal(status, 200);
  assert.equal(body.routed, 'session');
  assert.equal(body.target, 'codex-bbb222');
  assert.equal(body.degraded, undefined);
  assert.deepEqual(await readLines(inbox), inboxBefore);
  assert.equal(JSON.parse((await readLines(join(sessionsDir, 'codex-bbb222.jsonl'))).at(-1)).id, 's1');
});

test('an unknown target degrades to the shared inbox, visibly', async () => {
  const inboxBefore = await readLines(inbox);
  const ghost = join(sessionsDir, 'ghost-ffffff.jsonl');
  assert.equal(existsSync(ghost), false);

  const { status, body } = await post({ annotations: [{ id: 'g1', note: 'nobody there' }], targetSession: 'ghost-ffffff' });
  assert.equal(status, 200);
  assert.equal(body.routed, 'broadcast');
  assert.equal(body.degraded, true);
  assert.equal(body.reason, 'unknown-session');
  assert.equal(body.target, 'ghost-ffffff');
  assert.equal(body.pending, inboxBefore.length + 1);

  const inboxAfter = await readLines(inbox);
  assert.equal(inboxAfter.length, inboxBefore.length + 1);
  assert.equal(JSON.parse(inboxAfter.at(-1)).id, 'g1');
  // Only a lease record may bring a queue file into existence (§4.5 safety side).
  assert.equal(existsSync(ghost), false);

  const audit = (await readFile(join(root, '.vibepin', 'routed.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(audit.at(-1).degraded, true);
  assert.equal(audit.at(-1).reason, 'unknown-session');
});

test('an illegal target is refused before anything is written', async () => {
  const inboxBefore = await readFile(inbox, 'utf8');
  const dirBefore = (await readdir(sessionsDir)).sort();

  const bad = ['../../evil', '..', 'a/b', 'a\\b', '.hidden', '-lead', 'x'.repeat(65), 42, { sid: 'x' }];
  for (const targetSession of bad) {
    const { status, body } = await post({ annotations: [{ id: `bad-${String(targetSession).slice(0, 8)}` }], targetSession });
    assert.equal(status, 400, `targetSession ${JSON.stringify(targetSession)} must be refused`);
    assert.equal(body.error, 'bad targetSession');
  }
  assert.equal(await readFile(inbox, 'utf8'), inboxBefore);
  assert.deepEqual((await readdir(sessionsDir)).sort(), dirBefore);
  assert.equal(existsSync(join(root, '.vibepin', 'evil.jsonl')), false);
});

test('/health counts every queue, and /sessions stays read-only', async () => {
  const inboxPending = (await readLines(inbox)).length;
  // Every queue line except the claimed q1, plus every inbox line: the number the
  // two views must agree on. Both are served from ONE snapshot (§4.4), so wait for
  // a tick that has already seen the files written by the tests above.
  const expectedTotal = inboxPending + 2 /* omp: q2, t1 */ + 1 /* codex: s1 */;
  const body = await waitFor('a snapshot that has seen this test\'s files', async () => {
    const h = (await get('/health')).body;
    return h.pending === inboxPending && h.sessions === 2 ? h : null;
  });
  const snap = (await get('/sessions')).body;
  const queuePending = snap.sessions.reduce((n, s) => n + s.pending, 0);
  assert.equal(body.sessions, snap.sessions.length);
  assert.equal(body.pendingTotal, expectedTotal);
  assert.equal(body.pendingTotal, inboxPending + queuePending);
  assert.ok(body.pendingTotal >= body.pending);

  // Invariant 2: the session table has no write side. POST is not routed.
  const res = await fetch(`${base}/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 404);
});
