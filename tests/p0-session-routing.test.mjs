// P0 regression suite for docs/20260918-session-routing-design.md §7, plus the
// §8.1 / §11.3 CLI surface. Zero deps: node:test + node:assert.
//
//   node --test tests/
//
// The "BEFORE" arm of every P0 case runs the code as committed (extracted with
// `git show HEAD:<file>` into a temp dir), so each fix is proven to fail before
// and pass after without rewriting repo history.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const STORE = join(REPO, 'daemon', 'store.js');
const WATCH = join(REPO, 'daemon', 'watch.js');
const CLAIM = join(REPO, 'daemon', 'claim.js');
const CLI = join(REPO, 'bin', 'vibepin.js');

// --- the shipped (pre-fix) scripts, extracted once -----------------------------

const OLD = mkdtempSync(join(tmpdir(), 'vibepin-old-'));
const OLD_SCRIPT = { watch: join(OLD, 'watch.mjs'), claim: join(OLD, 'claim.mjs') };
const heap = [OLD];

for (const [name, src] of [['watch', 'daemon/watch.js'], ['claim', 'daemon/claim.js'], ['store', 'daemon/store.js']]) {
  const text = execFileSync('git', ['-C', REPO, 'show', `HEAD:${src}`], { encoding: 'utf8', maxBuffer: 1 << 24 });
  writeFileSync(join(OLD, `${name}.mjs`), text);
}
const oldStore = await import(pathToFileURL(join(OLD, 'store.mjs')).href);
const newStore = await import(pathToFileURL(STORE).href);

// The unfixed wake rule, for the missing-inbox regression: it treated *every*
// fs.watchFile event as a wake instead of comparing signatures.
const BROKEN_WAKE = join(OLD, 'broken-wake.mjs');
writeFileSync(BROKEN_WAKE, `import { watchFile } from 'node:fs';
watchFile(process.argv[2], { interval: 400 }, () => { console.log('[vibepin] wake: any event is a wake'); process.exit(0); });
console.log('[vibepin] watching');
`);

after(() => {
  for (const dir of heap) rmSync(dir, { recursive: true, force: true });
});

// --- helpers -------------------------------------------------------------------

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'vibepin-p0-'));
  heap.push(dir);
  return dir;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function start(script, args, cwd = REPO) {
  const child = spawn(process.execPath, [script, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const state = { out: '', err: '', code: null };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => { state.out += d; });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { state.err += d; });
  const exited = new Promise((res) => child.on('exit', (code) => { state.code = code; res(code); }));
  return { child, state, exited };
}

async function run(script, args, cwd = REPO) {
  const p = start(script, args, cwd);
  await p.exited;
  return p.state;
}

async function until(pred, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(25);
  }
  return false;
}

const idsOf = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => {
  try { return JSON.parse(line).id; } catch { return undefined; }
});

const line = (id, note) => `${JSON.stringify({ id, note })}\n`;

const watchArgs = (inbox, extra = []) => ['--inbox', inbox, ...extra];

// --- §7.1 watch -----------------------------------------------------------------

test('P0-1 a shrunk/replaced inbox wakes the watcher (was: byte baseline went blind)', async () => {
  const dir = tmp();
  const inbox = join(dir, 'inbox.jsonl');
  const big = Array.from({ length: 4 }, (_, i) => JSON.stringify({ id: `big-${i}`, note: 'x'.repeat(80) })).join('\n') + '\n';
  const small = line('small-1', 'y');
  assert.ok(big.length > 300 && small.length < 60, 'fixture: the follow-up annotation is smaller than the armed file');

  // BEFORE: armed at 400 bytes, content replaced with 30 -> the old size-only
  // counter can never fire again.
  writeFileSync(inbox, big);
  const before = start(OLD_SCRIPT.watch, watchArgs(inbox));
  assert.ok(await until(() => before.state.out.includes('watching')), `old watcher never armed: ${before.state.out}${before.state.err}`);
  await sleep(150);
  writeFileSync(inbox, small);
  await sleep(1400);
  assert.equal(before.state.code, null, 'BEFORE-FIX: expected the shipped byte-only watcher to stay parked after the file shrank');
  before.child.kill();
  await before.exited;

  // AFTER: the {size,mtimeMs,ino} triple notices the shrink and exits 0.
  writeFileSync(inbox, big);
  const after1 = start(WATCH, watchArgs(inbox));
  assert.ok(await until(() => after1.state.out.includes('watching')), `watcher never armed: ${after1.state.out}${after1.state.err}`);
  await sleep(150);
  writeFileSync(inbox, small);
  const code = await Promise.race([after1.exited, sleep(3000).then(() => 'timeout')]);
  assert.equal(code, 0, `AFTER-FIX: expected exit 0 on shrink, got ${code} (${after1.state.out}${after1.state.err})`);
  assert.match(after1.state.out, /\[vibepin\] wake: .*changed/);
});

test('P0-1b a replaced inode wakes the watcher (rename onto the path)', async () => {
  const dir = tmp();
  const inbox = join(dir, 'inbox.jsonl');
  writeFileSync(inbox, line('a', 'first'));
  const p = start(WATCH, watchArgs(inbox));
  assert.ok(await until(() => p.state.out.includes('watching')));
  await sleep(150);
  const other = join(dir, 'other.jsonl');
  writeFileSync(other, line('b', 'second'));
  execFileSync(process.execPath, ['-e', `require('fs').renameSync(${JSON.stringify(other)}, ${JSON.stringify(inbox)})`]);
  const code = await Promise.race([p.exited, sleep(3000).then(() => 'timeout')]);
  assert.equal(code, 0, `expected exit 0 after rename, got ${code} (${p.state.out}${p.state.err})`);
});

test('P0-1c an unreadable inbox exits non-zero with a diagnostic (was: folded into "0 bytes")', async () => {
  const dir = tmp();
  const blocker = join(dir, 'not-a-dir.txt');
  writeFileSync(blocker, 'x');
  const inbox = join(blocker, 'inbox.jsonl'); // stat -> ENOTDIR, not ENOENT

  const before = start(OLD_SCRIPT.watch, watchArgs(inbox));
  assert.ok(await until(() => before.state.out.includes('watching')), `old watcher never armed: ${before.state.out}`);
  await sleep(900);
  assert.equal(before.state.code, null, 'BEFORE-FIX: expected the shipped watcher to hide the stat failure and park');
  assert.ok(!/cannot stat/.test(before.state.err), 'BEFORE-FIX: no diagnostic is printed');
  before.child.kill();
  await before.exited;

  const after1 = await run(WATCH, watchArgs(inbox));
  assert.equal(after1.code, 2, `AFTER-FIX: expected exit 2, got ${after1.code} (${after1.state ?? after1.out})`);
  assert.match(after1.err, /cannot stat .*inbox\.jsonl/);
});

test('P0-1d a non-empty session queue wakes immediately instead of parking', async () => {
  const dir = tmp();
  const inbox = join(dir, 'inbox.jsonl');
  const queue = join(dir, 'sessions', 's1.jsonl');
  mkdirSync(dirname(queue), { recursive: true });
  writeFileSync(inbox, '');
  writeFileSync(queue, line('q-1', 'queued'));

  // BEFORE: --queue is not even a flag, so the shipped watcher just parks.
  const before = start(OLD_SCRIPT.watch, watchArgs(inbox, ['--queue', queue, '--session', 's1']));
  assert.ok(await until(() => before.state.out.includes('watching')));
  await sleep(1200);
  assert.equal(before.state.code, null, 'BEFORE-FIX: expected the shipped watcher to park with a pending queue');
  before.child.kill();
  await before.exited;

  const after1 = await run(WATCH, watchArgs(inbox, ['--queue', queue, '--session', 's1']));
  assert.equal(after1.code, 0, `AFTER-FIX: expected immediate exit 0, got ${after1.code} (${after1.err})`);
  assert.match(after1.out, /wake: queue already has 1 pending/);
});

test('P0-1e an inbox that does not exist is a stable baseline, not a wake', async () => {
  const dir = tmp();
  const inbox = join(dir, 'inbox.jsonl'); // never created: the daemon creates it on the first POST

  // BEFORE: the unfixed rule (any fs.watchFile event is a wake). On Windows an
  // absent path yields one event right after arming, so a fresh watcher woke
  // instantly with "changed (missing → missing)" and exited 0 with nothing to do.
  const broken = start(BROKEN_WAKE, [inbox]);
  assert.ok(await until(() => broken.state.out.includes('watching')));
  await sleep(1500);
  const spurious = broken.state.code === 0;
  broken.child.kill();
  await broken.exited;
  if (process.platform === 'win32') {
    assert.ok(spurious, 'fixture: expected fs.watchFile to report the absent path — that event is what the fix must ignore');
  } else if (!spurious) {
    console.log('note: this platform does not emit the spurious event; the AFTER arm still pins the contract');
  }

  // AFTER: parked and silent while the file does not exist, then woken once — and
  // once only — by it actually appearing.
  const p = start(WATCH, watchArgs(inbox));
  assert.ok(await until(() => p.state.out.includes('watching')), `watcher never armed: ${p.state.out}${p.state.err}`);
  await sleep(1500);
  assert.equal(p.state.code, null, `AFTER-FIX: a missing inbox must not wake the watcher (${p.state.out})`);
  assert.ok(!/wake:/.test(p.state.out), 'no wake line before anything happened');

  writeFileSync(inbox, line('appeared', 'first note'));
  const code = await Promise.race([p.exited, sleep(3000).then(() => 'timeout')]);
  assert.equal(code, 0, `AFTER-FIX: expected exit 0 once the inbox exists, got ${code} (${p.state.out}${p.state.err})`);
  assert.match(p.state.out, /wake: .*missing → \d+B /, 'the reason names the missing → present transition');
});

test('P0-1f a note landing in either file wakes the watcher (one baseline per file)', async () => {
  const dir = tmp();
  const inbox = join(dir, 'inbox.jsonl');
  const queue = join(dir, 'sessions', 's1.jsonl');
  writeFileSync(inbox, '');
  mkdirSync(dirname(queue), { recursive: true });

  // The session queue alone (directed note): it does not exist when the watcher
  // arms, so this is also the absent → present transition on the queue's baseline.
  const p = start(WATCH, watchArgs(inbox, ['--queue', queue, '--session', 's1']));
  assert.ok(await until(() => p.state.out.includes('watching')), `watcher never armed: ${p.state.out}${p.state.err}`);
  await sleep(500);
  assert.equal(p.state.code, null, 'parked while both files are empty');
  writeFileSync(queue, line('q-1', 'directed'));
  const code = await Promise.race([p.exited, sleep(3000).then(() => 'timeout')]);
  assert.equal(code, 0, `expected exit 0 on a queue-only change, got ${code} (${p.state.out}${p.state.err})`);
  assert.match(p.state.out, /wake: .*s1\.jsonl changed/);

  // The shared inbox alone (broadcast), with a drained queue so the immediate-wake
  // path cannot mask it.
  const drained = await run(CLAIM, ['--inbox', inbox, '--queue', queue, '--session', 's1']);
  assert.equal(drained.code, 0, drained.err);
  const p2 = start(WATCH, watchArgs(inbox, ['--queue', queue, '--session', 's1']));
  assert.ok(await until(() => p2.state.out.includes('watching')));
  await sleep(500);
  assert.equal(p2.state.code, null, 'parked after the queue was drained');
  writeFileSync(inbox, line('b-1', 'broadcast'));
  const code2 = await Promise.race([p2.exited, sleep(3000).then(() => 'timeout')]);
  assert.equal(code2, 0, `expected exit 0 on an inbox-only change, got ${code2} (${p2.state.out}${p2.state.err})`);
  assert.match(p2.state.out, /wake: .*inbox\.jsonl changed/);
});

// --- §7.2 claim -----------------------------------------------------------------

test('P0-2 claim recovers an orphan .claiming instead of destroying it', async () => {
  const fixture = (dir) => {
    const inbox = join(dir, 'inbox.jsonl');
    writeFileSync(inbox, line('new-1', 'live batch'));
    writeFileSync(`${inbox}.claiming`, line('old-1', 'orphan batch'));
    return inbox;
  };

  // BEFORE: the next rename replaces the orphan, so old-1 exists nowhere afterwards.
  const beforeDir = tmp();
  const beforeInbox = fixture(beforeDir);
  const before = await run(OLD_SCRIPT.claim, ['--inbox', beforeInbox]);
  assert.ok(before.out.includes('new-1'), 'BEFORE arm should still claim the live batch');
  const processedBefore = readFileSync(join(beforeDir, 'processed.jsonl'), 'utf8');
  assert.ok(!processedBefore.includes('old-1'), 'BEFORE-FIX: expected the orphan batch to be missing from the archive');
  assert.ok(!existsSync(`${beforeInbox}.claiming`), 'BEFORE-FIX: expected the orphan file to be gone from disk');

  // AFTER: the orphan is archived AND delivered before the live batch is claimed.
  const afterDir = tmp();
  const afterInbox = fixture(afterDir);
  const after1 = await run(CLAIM, ['--inbox', afterInbox]);
  assert.equal(after1.code, 0, after1.err);
  const processed = readFileSync(join(afterDir, 'processed.jsonl'), 'utf8');
  assert.ok(processed.includes('old-1'), 'AFTER-FIX: the orphan batch must be archived');
  assert.ok(processed.includes('new-1'), 'AFTER-FIX: the live batch must be archived');
  assert.match(after1.err, /recovered 1 annotation\(s\) .*old-1/);
  assert.deepEqual(JSON.parse(after1.out).map((i) => i.id), ['old-1', 'new-1']);
  assert.ok(!existsSync(`${afterInbox}.claiming`));
});

test('P0-2b claim --recover delivers only the orphan and leaves live files alone', async () => {
  const dir = tmp();
  const inbox = join(dir, 'inbox.jsonl');
  writeFileSync(inbox, line('live-1', 'still waiting'));
  writeFileSync(`${inbox}.claiming`, line('orphan-1', 'from a crash'));

  const out = await run(CLAIM, ['--inbox', inbox, '--recover']);
  assert.equal(out.code, 0, out.err);
  assert.deepEqual(JSON.parse(out.out).map((i) => i.id), ['orphan-1']);
  assert.ok(existsSync(inbox), '--recover must not drain live files');
  assert.ok(readFileSync(inbox, 'utf8').includes('live-1'));
  assert.ok(readFileSync(join(dir, 'processed.jsonl'), 'utf8').includes('orphan-1'));

  const again = await run(CLAIM, ['--inbox', inbox, '--recover']);
  assert.deepEqual(JSON.parse(again.out), [], 'a second --recover has nothing left');
});

test('P0-3 claim drains the second file when the first one is missing', async () => {
  const dir = tmp();
  const missingInbox = join(dir, 'inbox.jsonl'); // never created
  const queue = join(dir, 'sessions', 's1.jsonl');
  mkdirSync(dirname(queue), { recursive: true });
  writeFileSync(queue, line('q-1', 'directed'));

  // BEFORE: the shipped claim only knows --inbox, so the queue is never touched.
  const before = await run(OLD_SCRIPT.claim, ['--inbox', missingInbox, '--queue', queue, '--session', 's1']);
  assert.equal(before.out.trim(), '[]', 'BEFORE-FIX: expected the old claim to give up on the missing first file');
  assert.ok(existsSync(queue), 'BEFORE-FIX: expected the session queue to stay untouched');

  // AFTER: each file is claimed independently.
  const after1 = await run(CLAIM, ['--inbox', missingInbox, '--queue', queue, '--session', 's1']);
  assert.equal(after1.code, 0, after1.err);
  assert.deepEqual(JSON.parse(after1.out).map((i) => i.id), ['q-1']);
  assert.ok(!existsSync(queue), 'AFTER-FIX: the queue must be drained');
  assert.ok(readFileSync(join(dir, 'processed.jsonl'), 'utf8').includes('q-1'));
  assert.ok(existsSync(join(dir, 'claims.jsonl')), 'claims.jsonl is the append-only accounting');
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'claims.jsonl'), 'utf8').trim()).sessionId, 's1');
});

test('P0-3c claim refuses a path that is a directory instead of renaming it aside', async () => {
  const dir = tmp();
  const projDir = join(dir, '.vibepin'); // the classic typo: --inbox <project>/.vibepin
  mkdirSync(projDir, { recursive: true });
  writeFileSync(join(projDir, 'inbox.jsonl'), line('n-1', 'note'));

  const out = await run(CLAIM, ['--inbox', projDir]);
  assert.equal(out.code, 1, `expected exit 1, got ${out.code}`);
  assert.match(out.err, /is not a file .*it is a directory/);
  assert.ok(existsSync(join(projDir, 'inbox.jsonl')), 'the project tree must not be moved aside');
  assert.ok(!existsSync(`${projDir}.claiming`), 'nothing may be renamed aside');

  const w = await run(WATCH, ['--inbox', projDir]);
  assert.equal(w.code, 1, `watch must refuse it too, got ${w.code}`);
  assert.match(w.err, /is not a file/);
});

test('P0-3b both files drain, queue batch first, duplicate ids once', async () => {
  const dir = tmp();
  const inbox = join(dir, 'inbox.jsonl');
  const queue = join(dir, 'sessions', 's1.jsonl');
  mkdirSync(dirname(queue), { recursive: true });
  writeFileSync(queue, line('dup', 'from queue') + line('q-2', 'from queue'));
  writeFileSync(inbox, line('dup', 'from inbox') + line('b-2', 'from inbox'));

  const out = await run(CLAIM, ['--inbox', inbox, '--queue', queue, '--session', 's1']);
  assert.equal(out.code, 0, out.err);
  const items = JSON.parse(out.out);
  assert.deepEqual(items.map((i) => i.id), ['dup', 'q-2', 'b-2'], 'queue first, deduped, then the shared inbox');
  assert.equal(items[0].note, 'from queue', 'the first occurrence wins');
  assert.ok(!existsSync(queue) && !existsSync(inbox), 'both files are drained');
  assert.equal(readFileSync(join(dir, 'processed.jsonl'), 'utf8').trim().split('\n').length, 3);
});

// --- §7.3 store -----------------------------------------------------------------

test('P0-4 an append during resolve is never erased (was: whole-file rewrite)', async () => {
  const rounds = 200;
  const setup = (dir) => {
    const inbox = join(dir, 'inbox.jsonl');
    writeFileSync(inbox, line('a', 'the id being resolved'));
    return inbox;
  };

  // BEFORE: resolveByIds snapshots the file, awaits, then overwrites it whole.
  const beforeInbox = setup(tmp());
  const before = oldStore.createStore(beforeInbox);
  for (let i = 0; i < rounds; i++) {
    const p = before.resolveByIds(['a']);
    await before.append([{ id: `concurrent-${i}` }]);
    await p;
  }
  const survivedBefore = idsOf(beforeInbox).filter((id) => typeof id === 'string' && id.startsWith('concurrent-')).length;
  assert.ok(survivedBefore < rounds, `BEFORE-FIX: expected the read-modify-write to lose appends, survived ${survivedBefore}/${rounds}`);

  // AFTER: resolve only appends to claims.jsonl; queues are never rewritten.
  const afterInbox = setup(tmp());
  const after1 = newStore.createStore(afterInbox);
  for (let i = 0; i < rounds; i++) {
    const p = after1.resolveByIds(['a']);
    await after1.append([{ id: `concurrent-${i}` }]);
    await p;
  }
  const survivedAfter = idsOf(afterInbox).filter((id) => typeof id === 'string' && id.startsWith('concurrent-')).length;
  assert.equal(survivedAfter, rounds, `AFTER-FIX: lost ${rounds - survivedAfter}/${rounds} appended annotations`);

  // `a` is claimed, so it is filtered on read (no rewrite ever removed its line).
  assert.equal(await after1.count(afterInbox), rounds, 'count() must be unclaimed LINES, not bytes');
  assert.equal(await after1.countLines(afterInbox), rounds + 1, 'the claimed line is still physically present');
  assert.equal(await after1.readPending().then((items) => items.length), rounds);
  assert.ok((await after1.countLines(afterInbox)) < readFileSync(afterInbox, 'utf8').length + 1, 'line count is not a byte count');
});

test('P0-4b resolveByIds is idempotent and readAll dedupes across files', async () => {
  const dir = tmp();
  const inbox = join(dir, 'inbox.jsonl');
  const queue = join(dir, 'sessions', 's1.jsonl');
  mkdirSync(dirname(queue), { recursive: true });
  writeFileSync(inbox, line('x', 'inbox copy'));
  writeFileSync(queue, line('x', 'queue copy') + line('y', 'queue only'));

  const store = newStore.createStore(inbox);
  const files = [store.queuePath('s1'), store.INBOX];
  assert.deepEqual((await store.readAll(files)).map((i) => i.note), ['queue copy', 'queue only'], 'same id twice -> delivered once, queue wins');
  assert.equal(await store.resolveByIds(['x'], files, { sessionId: 's1' }), 1);
  assert.equal(await store.resolveByIds(['x'], files, { sessionId: 's1' }), 0, 'claiming the same id twice resolves nothing');
  assert.deepEqual((await store.readAll(files)).map((i) => i.id), ['y']);
  assert.equal(await store.pendingTotal(), 1);
  const claims = readFileSync(store.CLAIMS, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(claims.length, 1, 'one accounting line per batch');
  assert.deepEqual(claims[0], { ids: ['x'], sessionId: 's1', at: claims[0].at });
  assert.ok(Number.isFinite(claims[0].at));
});

test('P0-4c waitForAny survives a shrink (the MCP long-poll path)', async () => {
  const dir = tmp();
  const inbox = join(dir, 'inbox.jsonl');
  writeFileSync(inbox, 'x'.repeat(400));
  const store = newStore.createStore(inbox);
  const pending = store.waitForAny([inbox], { timeoutMs: 5000, intervalMs: 50 });
  await sleep(120);
  writeFileSync(inbox, line('after-shrink', 'small'));
  const items = await pending;
  assert.deepEqual(items.map((i) => i.id), ['after-shrink']);

  // The MCP client resolved it: reads are filtered against claims.jsonl, so the
  // next long-poll has nothing left and must return [] on timeout to loop.
  assert.equal(await store.resolveByIds(['after-shrink'], [inbox]), 1);
  const empty = store.waitForAny([inbox], { timeoutMs: 300, intervalMs: 50 });
  assert.deepEqual(await empty, [], 'timeout returns [] so the caller can loop');
});

// --- §8.1 / §4.2 leases ---------------------------------------------------------

test('P1-1 watch registers a lease, claim refreshes it and appends claims.jsonl', async () => {
  const dir = tmp();
  const inbox = join(dir, 'inbox.jsonl');
  const queue = join(dir, 'sessions', 'omp-abc123.jsonl');
  mkdirSync(dirname(queue), { recursive: true });
  writeFileSync(inbox, '');

  const watcher = start(WATCH, ['--inbox', inbox, '--queue', queue, '--session', 'omp-abc123', '--label', '改简历解析页', '--agent', 'omp']);
  assert.ok(await until(() => watcher.state.out.includes('watching')), `watcher never armed: ${watcher.state.err}`);
  const lease = JSON.parse(readFileSync(join(dir, 'sessions', 'omp-abc123.json'), 'utf8'));
  assert.equal(lease.agent, 'omp');
  assert.equal(lease.label, '改简历解析页');
  assert.equal(lease.mode, 'file');
  assert.equal(lease.watcherPid, watcher.child.pid);
  assert.ok(Number.isFinite(lease.lastReArmAt));
  assert.ok(typeof lease.startedAt === 'string' && !Number.isNaN(Date.parse(lease.startedAt)));
  watcher.child.kill();
  await watcher.exited;

  writeFileSync(queue, line('q-1', 'directed'));
  const out = await run(CLAIM, ['--inbox', inbox, '--queue', queue, '--session', 'omp-abc123']);
  assert.equal(out.code, 0, out.err);
  assert.deepEqual(JSON.parse(out.out).map((i) => i.id), ['q-1']);
  const refreshed = JSON.parse(readFileSync(join(dir, 'sessions', 'omp-abc123.json'), 'utf8'));
  assert.ok(Number.isFinite(refreshed.lastClaimAt), 'claim --session refreshes lastClaimAt');
  assert.equal(refreshed.startedAt, lease.startedAt, 'a refresh never re-stamps startedAt');
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'claims.jsonl'), 'utf8').trim()), { ids: ['q-1'], sessionId: 'omp-abc123', at: refreshed.lastClaimAt });
});

test('P1-2 claim without --session writes no audit and no lease (old usage is untouched)', async () => {
  const dir = tmp();
  const inbox = join(dir, 'inbox.jsonl');
  writeFileSync(inbox, line('legacy-1', 'broadcast'));

  const before = await run(OLD_SCRIPT.claim, ['--inbox', inbox]);
  writeFileSync(inbox, line('legacy-1', 'broadcast'));
  rmSync(join(dir, 'processed.jsonl'));
  const after1 = await run(CLAIM, ['--inbox', inbox]);

  assert.equal(after1.out, before.out, 'legacy claim output is byte-identical to the shipped one');
  assert.equal(readFileSync(join(dir, 'processed.jsonl'), 'utf8'), line('legacy-1', 'broadcast'));
  assert.ok(!existsSync(join(dir, 'claims.jsonl')), 'no session -> no claims audit');
  assert.ok(!existsSync(join(dir, 'sessions')), 'no session -> no lease directory');
});

test('P1-3 a bare sid and a queue path both work, and a bad sid fails without writing', async () => {
  const dir = tmp();
  const inbox = join(dir, 'inbox.jsonl');
  writeFileSync(inbox, '');
  mkdirSync(join(dir, 'sessions'), { recursive: true });
  writeFileSync(join(dir, 'sessions', 's9.jsonl'), line('q-9', 'bare sid'));

  const bySid = await run(CLAIM, ['--inbox', inbox, '--queue', 's9']);
  assert.deepEqual(JSON.parse(bySid.out).map((i) => i.id), ['q-9']);

  writeFileSync(join(dir, 'sessions', 's9.jsonl'), line('q-10', 'by path'));
  const byPath = await run(CLAIM, ['--inbox', inbox, '--queue', join(dir, 'sessions', 's9.jsonl')]);
  assert.deepEqual(JSON.parse(byPath.out).map((i) => i.id), ['q-10']);

  const bad = await run(CLAIM, ['--inbox', inbox, '--queue', '../escape.jsonl', '--session', '../evil']);
  assert.equal(bad.code, 1, 'a bad sid exits 1');
  assert.match(bad.err, /bad sid/);
  assert.ok(!existsSync(join(dir, 'sessions', '..', 'evil.json')), 'nothing is written for a bad sid');
});

// --- §11.3 / §11.4 CLI ----------------------------------------------------------

test('P2-1 vibepin sessions lists leases with pending counts and last activity', async () => {
  const dir = tmp();
  const inbox = join(dir, '.vibepin', 'inbox.jsonl');
  mkdirSync(join(dir, '.vibepin', 'sessions'), { recursive: true });
  writeFileSync(inbox, '');
  writeFileSync(join(dir, '.vibepin', 'sessions', 'omp-1.json'), JSON.stringify({ agent: 'omp', label: 'one', mode: 'file', watcherPid: process.pid, lastReArmAt: Date.now() }));
  // The heartbeat for a file lease IS the lease file's mtime (§6.1), so "long
  // stale" only looks stale if the mtime is old too — a freshly written file with
  // lastReArmAt: 0 is still a fresh lease, and reporting it as stale would be the
  // 1970-timestamp mistake in reverse.
  const stalePath = join(dir, '.vibepin', 'sessions', 'codex-2.json');
  writeFileSync(stalePath, JSON.stringify({ agent: 'codex', mode: 'mcp', lastReArmAt: 0 }));
  const epoch = new Date(0);
  utimesSync(stalePath, epoch, epoch);
  writeFileSync(join(dir, '.vibepin', 'sessions', 'omp-1.jsonl'), line('p1', 'x') + line('p2', 'y'));
  writeFileSync(join(dir, '.vibepin', 'sessions', 'stale name.json'), '{}');

  const out = await run(CLI, ['sessions', '--json', '--root', dir]);
  assert.equal(out.code, 0, out.err);
  const { sessions } = JSON.parse(out.out);
  assert.deepEqual(sessions.map((s) => s.sessionId), ['omp-1', 'codex-2'], 'newest first, invalid filenames skipped');
  assert.equal(sessions[0].pending, 2, 'pending is unclaimed line count');
  assert.equal(sessions[0].watcher, process.pid);
  assert.equal(sessions[1].pending, 0);
  assert.ok(sessions[1].lastSeenAt > 1000, 'a 1970 lease is reported as long stale');

  const text = await run(CLI, ['sessions', '--root', dir]);
  assert.match(text.out, /omp-1\s+omp\s+2 pending/);
  assert.match(text.out, /claim --queue <sid>/, 'the hint must be the spec §11.4 recovery channel');

  // ...and that hint must really drain the queue it names: bare sid, no --queue path.
  const recovered = await run(CLI, ['claim', '--inbox', inbox, '--queue', 'omp-1']);
  assert.equal(recovered.code, 0, recovered.err);
  assert.deepEqual(JSON.parse(recovered.out).map((i) => i.id), ['p1', 'p2']);
  assert.ok(!existsSync(join(dir, '.vibepin', 'sessions', 'omp-1.jsonl')));
});

test('P2-2 init --agent omp reports the old protocol, and --upgrade rewrites only those two targets', async () => {
  const dir = tmp();
  mkdirSync(join(dir, '.omp', 'skills', 'vibepin-annotations'), { recursive: true });
  const agentsPath = join(dir, 'AGENTS.md');
  const skillPath = join(dir, '.omp', 'skills', 'vibepin-annotations', 'SKILL.md');
  writeFileSync(agentsPath, `# My project\n\nSome rules that must survive.\n\n## 注记（vibepin）\n\nold command: watch.js --inbox x && claim.js --inbox x\n\n## After\n\nkeep me\n`);
  writeFileSync(skillPath, 'old skill, no marker\n');

  // report only
  const report = await run(CLI, ['init', '--agent', 'omp', '--root', dir]);
  assert.equal(report.code, 0, report.err);
  assert.match(report.out, /OLD protocol/);
  assert.match(report.out, /re-run with --upgrade/);
  assert.ok(readFileSync(skillPath, 'utf8').includes('old skill'), 'without --upgrade nothing is rewritten');
  assert.ok(readFileSync(agentsPath, 'utf8').includes('old command'), 'the AGENTS.md section is untouched');

  // dry run plans the rewrite without writing
  const dry = await run(CLI, ['init', '--agent', 'omp', '--root', dir, '--upgrade', '--dry-run']);
  assert.match(dry.out, /rewrite\s+\.omp\/skills\/vibepin-annotations\/SKILL\.md/);
  assert.match(dry.out, /dry run/i);
  assert.ok(readFileSync(skillPath, 'utf8').includes('old skill'), '--dry-run writes nothing');

  // upgrade rewrites exactly the two targets
  const up = await run(CLI, ['init', '--agent', 'omp', '--root', dir, '--upgrade']);
  assert.equal(up.code, 0, up.err);
  assert.match(up.out, /rewrote \.omp\/skills\/vibepin-annotations\/SKILL\.md/);
  assert.match(up.out, /rewrote AGENTS\.md/);
  const skill = readFileSync(skillPath, 'utf8');
  assert.ok(skill.includes('<!-- vibepin:session-routing-v2 -->'), 'the v2 marker lands in SKILL.md');
  assert.ok(skill.includes('--queue'), 'the v2 commands are in the skill');
  const agents = readFileSync(agentsPath, 'utf8');
  assert.ok(agents.includes('<!-- vibepin:session-routing-v2 -->'), 'the v2 marker lands in the AGENTS.md section');
  assert.match(agents, /--queue .*sessions\/<sid>\.jsonl --session <sid>/, 'the printed command uses the new form');
  assert.ok(agents.startsWith('# My project\n\nSome rules that must survive.'), 'text before the section survives');
  assert.match(agents, /## After\n\nkeep me/, 'text after the section survives');
  assert.ok(!agents.includes('old command'), 'only the section body was replaced');

  // idempotent afterwards
  const again = await run(CLI, ['init', '--agent', 'omp', '--root', dir]);
  assert.match(again.out, /already session-routing-v2/);
  assert.match(again.out, /already wired up|Nothing to do/);
});

test('P2-3 init --dry-run works for the install agents and says what it would replace', async () => {
  const out = await run(CLI, ['init', '--agent', 'claude', '--dry-run']);
  assert.equal(out.code, 0, out.err);
  assert.match(out.out, /would (install|overwrite) \/vpin → /);
  assert.match(out.out, /replaced on every init/);
});

test('P2-4 doctor reports the registry, the protocol and the daemon without inventing defects', async () => {
  const dir = tmp();
  mkdirSync(join(dir, '.vibepin'), { recursive: true });
  // pin an unused port so the probe cannot reach a daemon someone else is running
  writeFileSync(join(dir, '.vibepin', 'config.json'), JSON.stringify({ agent: 'omp', inbox: '.vibepin/inbox.jsonl', root: '.', port: 7399 }));
  writeFileSync(join(dir, '.vibepin', 'inbox.jsonl'), '');
  mkdirSync(join(dir, '.vibepin', 'sessions'), { recursive: true });
  writeFileSync(join(dir, '.vibepin', 'sessions', 'omp-1.json'), JSON.stringify({ agent: 'omp', mode: 'file', watcherPid: 999999, lastReArmAt: Date.now() }));
  writeFileSync(join(dir, '.vibepin', 'sessions', 'omp-1.jsonl'), line('p1', 'waiting'));

  const out = await run(CLI, ['doctor', '--root', dir]);
  assert.match(out.out, /1 lease\(s\)/);
  assert.match(out.out, /watcher pid 999999 is gone — 1 pending/);
  assert.match(out.out, /no vibepin daemon reachable on port 7399/);
  assert.equal(out.code, 0, `warnings are not defects: ${out.out}`);
  assert.match(out.out, /no defects found/);

  // a config the daemon would refuse is a defect
  writeFileSync(join(dir, '.vibepin', 'config.json'), '{ not json');
  const broken = await run(CLI, ['doctor', '--root', dir]);
  assert.equal(broken.code, 1);
  assert.match(broken.out, /✗ .*not valid JSON/);
});

test('P2-5 doctor does not call a backslash-continued v2 command "old protocol"', async () => {
  const dir = tmp();
  mkdirSync(join(dir, '.vibepin'), { recursive: true });
  writeFileSync(join(dir, '.vibepin', 'config.json'), JSON.stringify({ agent: 'omp', inbox: '.vibepin/inbox.jsonl', root: '.', port: 7399 }));
  writeFileSync(join(dir, '.vibepin', 'inbox.jsonl'), '');
  // The §8.1 shape: --queue/--session live on the continuation lines, so a
  // per-line test would see "--inbox" on line 5 and no "--queue" anywhere on it.
  writeFileSync(join(dir, 'AGENTS.md'), [
    '## 注记（vibepin）',
    '',
    '<!-- vibepin:session-routing-v2 -->',
    '',
    'node /vibepin/daemon/watch.js --inbox /p/.vibepin/inbox.jsonl \\',
    '     --queue /p/.vibepin/sessions/<sid>.jsonl --session <sid> \\',
    '  && node /vibepin/daemon/claim.js --inbox /p/.vibepin/inbox.jsonl \\',
    '     --queue /p/.vibepin/sessions/<sid>.jsonl --session <sid>',
    '',
  ].join('\n'));

  const clean = await run(CLI, ['doctor', '--root', dir]);
  assert.doesNotMatch(clean.out, /old protocol command/);
  assert.match(clean.out, /no watch\/claim invocation on the old --inbox-only protocol found/);
  assert.equal(clean.code, 0, clean.out);

  // ...while a genuinely --inbox-only command is still reported.
  writeFileSync(join(dir, 'AGENTS.md'), [
    '## 注记（vibepin）',
    '',
    'node /vibepin/daemon/watch.js --inbox /p/.vibepin/inbox.jsonl && node /vibepin/daemon/claim.js --inbox /p/.vibepin/inbox.jsonl',
    '',
  ].join('\n'));
  const stale = await run(CLI, ['doctor', '--root', dir]);
  assert.match(stale.out, /old protocol command — AGENTS\.md/);
});
