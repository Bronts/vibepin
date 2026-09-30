// P3: the mechanical delivery protocol — write batches, the claim ledger, the
// delivery header, ack and report (docs/20260919-batch-ledger.md).
//
//   node --test tests/
//
// These tests pin the v4/v4.1 shape, which overrides the v3 draft wherever the two
// disagree: there is NO delivery gate. watch and claim deliver whenever there is
// work and exit 0; an unsettled earlier batch shows up as the `## 未结清` block in
// the delivery header (one ack command per item, never `--all-done`) and in
// `vibepin report` (exit 3). TTL is a report label, not a delivery qualifier.
// `--json` is the pre-ledger machine contract, byte for byte.
//
// v4.1: the DEFAULT stdout is the instruction layer only — header + retrieval hint
// + ## 未结清 + digest, all of it inside a 3000-character budget, with no JSON
// inlined (the evidence layer is one `show --seq <n> --evidence` away). `--full`
// brings back the v4 default shape (header + debt + raw digest + the whole array).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const CLAIM = join(REPO, 'daemon', 'claim.js');
const WATCH = join(REPO, 'daemon', 'watch.js');
const CLI = join(REPO, 'bin', 'vibepin.js');
const BATCHES = join(REPO, 'daemon', 'batches.js');
const B = await import(pathToFileURL(BATCHES).href);

// The MCP tool surface, reached directly: mcp.js imports the SDK lazily, so the
// routing/accounting bindings are callable with no node_modules installed.
const { createToolBindings } = await import(pathToFileURL(join(REPO, 'daemon', 'mcp.js')).href);
const { createStore } = await import(pathToFileURL(join(REPO, 'daemon', 'store.js')).href);

// The pre-ledger claim, extracted so `--json` can be compared byte for byte
// (T5). Both files land as .js: the old script imports './store.js'.
const OLD = mkdtempSync(join(tmpdir(), 'vibepin-old-'));
for (const [name, src] of [['claim', 'daemon/claim.js'], ['store', 'daemon/store.js']]) {
  writeFileSync(join(OLD, `${name}.js`), execFileSync('git', ['-C', REPO, 'show', `HEAD:${src}`], { encoding: 'utf8', maxBuffer: 1 << 24 }));
}
const OLD_CLAIM = join(OLD, 'claim.js');

const heap = [OLD];
after(() => {
  for (const dir of heap) rmSync(dir, { recursive: true, force: true });
});

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'vibepin-p3-'));
  heap.push(dir);
  return dir;
};

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A throwaway project: <.vibepin>/inbox.jsonl + sessions/<sid>.jsonl, exactly the
// layout claim.js derives every path from.
function project() {
  const dir = tmp();
  const vibepin = join(dir, '.vibepin');
  const sessions = join(vibepin, 'sessions');
  mkdirSync(sessions, { recursive: true });
  const inbox = join(vibepin, 'inbox.jsonl');
  writeFileSync(inbox, '');
  return {
    dir,
    vibepin,
    inbox,
    sessions,
    queue: (sid) => join(sessions, `${sid}.jsonl`),
    ledger: (id) => join(vibepin, 'batches', `${id}.json`),
    claims: () => readJsonl(join(vibepin, 'claims.jsonl')),
    processed: () => readJsonl(join(vibepin, 'processed.jsonl')),
    ledgers: () => {
      try {
        return readdirSync(join(vibepin, 'batches')).filter((n) => n.endsWith('.json')).sort();
      } catch {
        return [];
      }
    },
  };
}

const readJsonl = (file) => {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
};

const record = (id, extra = {}) => ({
  id,
  ts: 1758182462000,
  url: 'http://localhost:5173/resume-parse',
  note: `note ${id}`,
  kind: 'element',
  selector: `#${id}`,
  component: 'Upload',
  source: 'frontend/src/Upload.vue:12',
  chain: ['Upload', 'App'],
  container: { selector: '.card' },
  elements: [{ tag: 'button' }],
  ...extra,
});

const seed = (file, ...records) => writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
const append = (file, ...records) => appendFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

const claimArgs = (f, sid) => ['--inbox', f.inbox, '--queue', sid, '--session', sid];
const cli = (f, ...args) => run(CLI, [...args, '--root', f.dir]);

const ledgerOf = (f, id) => JSON.parse(readFileSync(f.ledger(id), 'utf8'));

// `resolve` only reaches sessions.valid / writeLease / queuePath; the real object
// is built in daemon.js, which opens the HTTP server as a side effect of import.
const sessionsFake = (inbox) => ({
  valid: (sid) => typeof sid === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(sid),
  queuePath: (sid) => join(dirname(inbox), 'sessions', `${sid}.jsonl`),
  writeLease: async () => ({}),
  markInFlight: () => {},
});
const digestLines = (text) => text.split('\n').filter((l) => /^\d+\. /.test(l));
const tableRows = (text) => text.split('\n').filter((l) => /^\|\s*!?\d+\s*\|/.test(l));
const batchIdOf = (text) => /^\[vibepin\] 批 (b-\d{8}-\d{6}-[0-9a-f]{4}) ·/.exec(text)?.[1] ?? null;

// ---------------------------------------------------------------------------
// T1 — the ledger itself

test('T1 createBatch writes an atomic ledger whose counts add up', async () => {
  const f = project();
  const items = [record('q1'), record('q2', { url: 'http://localhost:5173/settings' }), record('b1')];
  const batch = await B.createBatch({
    inbox: f.inbox,
    sessionId: 's1',
    items,
    origins: [{ role: 'queue' }, { role: 'queue' }, { role: 'inbox' }],
    evidenceBase: 0,
    files: [{ role: 'inbox', path: f.inbox }],
    ttlMs: 0,
  });

  assert.equal(batch.total, items.length);
  assert.equal(batch.sources.queue + batch.sources.inbox, batch.total, 'queue + inbox === total');
  assert.equal(batch.sources.recovered, 0);
  assert.equal(batch.pages.reduce((n, p) => n + p.count, 0), batch.total, 'page counts === total');
  assert.deepEqual(batch.items.map((i) => i.seq), [1, 2, 3]);
  assert.deepEqual(batch.items.map((i) => i.status), ['open', 'open', 'open']);
  assert.deepEqual(batch.items.map((i) => i.sourceFile), ['queue', 'queue', 'inbox']);

  const names = readdirSync(join(f.vibepin, 'batches'));
  assert.ok(!names.some((n) => n.includes('.tmp-')), `no temp files left behind: ${names.join(', ')}`);

  // Two ids minted in the same millisecond still differ (the file name is the
  // ledger key, so a collision would overwrite someone else's batch).
  const a = B.newBatchId(f.inbox, 'b', 1758182462000);
  const b = B.newBatchId(f.inbox, 'b', 1758182462000);
  assert.notEqual(a, b);
  assert.match(a, /^b-\d{8}-\d{6}-[0-9a-f]{4}$/);
});

// T2 — evidence.line is a real pointer into processed.jsonl

test('T2 every ledger item points at the processed.jsonl line holding its record', async () => {
  const f = project();
  seed(f.queue('s1'), record('q1'), record('q2'));
  seed(f.inbox, record('b1'));

  const out = await run(CLAIM, claimArgs(f, 's1'));
  assert.equal(out.code, 0, out.err);
  assert.equal(f.ledgers().length, 1, 'one claim = one ledger');

  const batch = ledgerOf(f, f.ledgers()[0].replace(/\.json$/, ''));
  const processed = readFileSync(join(f.vibepin, 'processed.jsonl'), 'utf8').split('\n');
  assert.deepEqual(batch.items.map((i) => i.id), ['q1', 'q2', 'b1'], 'queue first, then the shared inbox');
  for (const item of batch.items) {
    const line = JSON.parse(processed[item.evidence.line - 1]);
    assert.equal(line.id, item.id, `evidence.line ${item.evidence.line} must hold ${item.id}`);
  }
  assert.deepEqual(f.claims().map((c) => c.batchId), [batch.id], 'claims.jsonl records the ledger id');
});

// T3 — v4.1 default stdout: the instruction layer, and nothing else

test('T3 the default delivery is the instruction layer — no JSON, budgeted', async () => {
  const f = project();
  seed(f.queue('s1'), record('q1'), record('q2'));
  seed(f.inbox, record('b1', { url: 'http://localhost:5173/settings' }));

  const out = await run(CLAIM, claimArgs(f, 's1'));
  assert.equal(out.code, 0, out.err);
  const id = batchIdOf(out.out);
  assert.ok(id, `first line must be greppable: ${out.out.split('\n')[0]}`);
  assert.match(out.out.split('\n')[0], /^\[vibepin\] 批 b-\d{8}-\d{6}-[0-9a-f]{4} · 3 条 · 2 个页面 · 会话 s1$/);
  assert.equal(digestLines(out.out).length, 3, 'one digest line per item');
  assert.ok(out.out.includes(f.ledger(id)), 'the ledger path is printed');
  assert.ok(out.out.includes(`ack --batch ${id} --seq`), 'the ack template is printed');
  assert.ok(out.out.length <= 3000, `the default stdout is budgeted, was ${out.out.length}`);

  // The evidence layer is not inlined any more: the digest rows carry the [e:…]
  // pointer and the retrieval hint says how to expand one.
  const rows = digestLines(out.out);
  for (const row of rows) assert.match(row, /\[e:\d+\/w:(-|[0-9a-f]{4})\]$/);
  assert.match(out.out, new RegExp(`vibepin show --batch ${id} --seq <n> --evidence`));
  assert.match(out.out, new RegExp(`vibepin show --batch ${id} --json`));
  assert.ok(out.out.includes('载荷 本批只投递"指令层"'), 'the payload hint is printed');
  assert.ok(!out.out.includes('\n[\n'), 'no JSON is inlined in the default output');
  assert.ok(!out.out.includes('"selector"'), 'not one record leaks into stdout');

  // The pointer is a real processed.jsonl line: row 1 -> [e:1].
  const line1 = /\[e:(\d+)\//.exec(rows[0]);
  assert.equal(line1[1], '1');
  assert.equal(f.processed()[0].id, 'q1');
});

// T3b — v4.1: --full is the v4 default shape (header + debt + digest + whole array)

test('T3b --full keeps the header, the digest and the whole payload', async () => {
  const f = project();
  seed(f.queue('s1'), record('q1'), record('q2'));
  seed(f.inbox, record('b1'));

  const out = await run(CLAIM, [...claimArgs(f, 's1'), '--full']);
  assert.equal(out.code, 0, out.err);
  const id = batchIdOf(out.out);
  assert.ok(id);
  assert.equal(digestLines(out.out).length, 3, 'the raw digest is not folded in --full');
  assert.ok(out.out.includes(f.ledger(id)), 'the ledger path is printed');
  assert.match(out.out, /\[e:\d+\/w:/, '--full keeps the per-row evidence pointers');

  const payload = JSON.parse(out.out.slice(out.out.indexOf('\n[\n') + 1));
  assert.deepEqual(payload.map((i) => i.id), ['q1', 'q2', 'b1']);
  assert.deepEqual(payload[0].chain, ['Upload', 'App']);
  assert.deepEqual(payload[0].container, { selector: '.card' });
  assert.deepEqual(payload[0].elements, [{ tag: 'button' }]);
  assert.equal(f.ledgers().length, 1, 'one delivery = one ledger, whatever the shape');
});

// T4 — v4.1: --brief is gone, loudly

test('T4 --brief is rejected and points at --full', async () => {
  const f = project();
  seed(f.queue('s1'), record('q1'));

  const out = await run(CLAIM, [...claimArgs(f, 's1'), '--brief']);
  assert.equal(out.code, 1, 'a removed flag must fail, not be silently ignored');
  assert.match(out.err, /--brief/);
  assert.match(out.err, /--full/);
  assert.ok(!out.out.includes('[e:'), 'nothing is delivered on a rejected flag');
  assert.equal(f.ledgers().length, 0, 'the flag is checked before any claim happens');

  const both = await run(CLAIM, [...claimArgs(f, 's1'), '--full', '--json']);
  assert.equal(both.code, 1, '--full and --json cannot both be asked for');
  assert.match(both.err, /mutually exclusive/);
});

// T4b — v4.1: the character budget is hard (40 long notes must not flood stdout)

test('T4b a 40-item long-note batch stays inside the 3000-char stdout budget', async () => {
  const long = (i) => `${'长'.repeat(300)} 原话 ${i}`;
  const records = Array.from({ length: 40 }, (_, i) => record(`p${i + 1}`, { note: long(i + 1) }));

  const f = project();
  seed(f.queue('s1'), ...records);
  const out = await run(CLAIM, claimArgs(f, 's1'));
  assert.equal(out.code, 0, out.err);
  const id = batchIdOf(out.out);
  assert.ok(id);
  assert.ok(out.out.length <= 3000, `default stdout must stay within 3000 chars, was ${out.out.length}`);
  assert.ok(out.out.includes(f.ledger(id)), 'the ledger path survives the budget');

  const rows = digestLines(out.out);
  assert.ok(rows.length > 0 && rows.length <= 25, `digest rows are capped at 25, was ${rows.length}`);
  assert.ok(rows.length < 40, 'the long notes cannot all fit');
  for (const row of rows) assert.ok(row.length <= 120, `a row must be <=120 chars, was ${row.length}: ${row}`);
  assert.match(out.out, new RegExp(`… 其余 ${40 - rows.length} 条见 vibepin show --batch ${id}`), 'the fold line says where the rest went');

  // A truncated row only loses its tail: processed.jsonl keeps the record verbatim
  // (the ledger keeps the note head, and the [e:…] pointer names the line).
  const first = /\[e:(\d+)\//.exec(rows[0]);
  assert.equal(first[1], '1');
  assert.equal(f.processed()[0].id, 'p1');
  assert.equal(f.processed()[0].note, long(1), 'the full note is archived verbatim');
  assert.equal(ledgerOf(f, id).items[0].note, `${long(1).slice(0, 160)}…`, 'the ledger keeps the note head');

  // The row cap belongs to the module, not to the fitting: with a row limit of 25
  // it is what bites, and it still folds instead of dropping the tail silently.
  const synthetic = { id, items: records.map((r, i) => ({ ...r, seq: i + 1 })), pages: [] };
  const capped = B.formatDigest(synthetic, { limit: 25, lineMax: 120 }).split('\n');
  assert.equal(capped.length, 26, '25 rows + the fold line');
  assert.equal(capped[25], `… 其余 15 条见 vibepin show --batch ${id}`);

  // The debt block is budgeted the same way: <=5 itemized rows, then one fold line.
  const d = project();
  seed(d.queue('s1'), ...Array.from({ length: 8 }, (_, i) => record(`d${i + 1}`, { note: `欠债 ${i + 1}` })));
  const firstBatch = await run(CLAIM, claimArgs(d, 's1'));
  assert.equal(firstBatch.code, 0, firstBatch.err);
  const debtId = batchIdOf(firstBatch.out);
  append(d.queue('s1'), ...records);
  const second = await run(CLAIM, claimArgs(d, 's1'));
  assert.equal(second.code, 0, second.err);
  assert.ok(second.out.length <= 3000, `debt + digest must still fit, was ${second.out.length}`);
  const debtRows = second.out.split('\n').filter((l) => /^- .+#\d+ \[/.test(l));
  assert.equal(debtRows.length, 5, 'at most 5 itemized debt rows');
  assert.match(second.out, new RegExp(`… 其余 3 条见 vibepin show --batch ${debtId}`));
  assert.ok(second.out.indexOf('## 未结清') > 0 && second.out.indexOf('## 未结清') < second.out.indexOf('\n1. '), 'debt precedes the digest');

  // --full keeps inlining the whole payload; --json is still the old contract.
  const g = project();
  seed(g.queue('s1'), ...records);
  const full = await run(CLAIM, [...claimArgs(g, 's1'), '--full']);
  assert.equal(full.code, 0, full.err);
  const payload = JSON.parse(full.out.slice(full.out.indexOf('\n[\n') + 1));
  assert.equal(payload.length, 40);
  assert.equal(payload[39].note, long(40), 'nothing is truncated in --full');
  assert.equal(digestLines(full.out).length, 40, '--full prints the unbudgeted digest');

  const j = project();
  seed(j.queue('s1'), ...records);
  const now = await run(CLAIM, [...claimArgs(j, 's1'), '--json']);
  const oldProject = project();
  seed(oldProject.queue('s1'), ...records);
  const before = await run(OLD_CLAIM, ['--inbox', oldProject.inbox, '--queue', 's1', '--session', 's1']);
  assert.equal(before.code, 0, before.err);
  assert.equal(now.out, before.out, '--json still equals the pre-ledger claim output, byte for byte');
});

// T4c — v4.1 fix: the note outlives the locator in a delivery row

test('T4c a long locator may not squeeze the note out of the digest row', async () => {
  // The real incident: a 95-char `<Comp> src/views/…/X.vue:64:9` left a 37-char
  // request as `就是这里的表头啊，要…` — the note is the request, so it wins.
  const note = '就是这里的表头啊，要参考那个学生的那个页面啊，有些列你要加上筛选啊';
  const place = {
    component: 'ResumeParseTaskTableCard',
    source: 'src/views/resume/components/ResumeParseTaskTableCard.vue:64:9',
  };
  const f = project();
  seed(f.queue('s1'), record('t1', { note, ...place }));

  const out = await run(CLAIM, claimArgs(f, 's1'));
  assert.equal(out.code, 0, out.err);
  const row = digestLines(out.out)[0];
  assert.ok(row, out.out);
  assert.ok(row.includes(note), `the whole note is printed, got: ${row}`);
  assert.match(row, /\[e:1\/w:-\]$/, 'the pointer survives');
  assert.match(row, /ResumeParseTaskTableCard\.vue:64:9/, 'the file name (and :line:col) is kept');
  assert.ok(!row.includes('src/views/'), `directories are dropped from the row: ${row}`);
  assert.ok(!/<ResumeParseTaskTableCard>/.test(row), `the duplicated component name is dropped: ${row}`);
  assert.ok(row.length <= 120, `the row stays <=120 chars, was ${row.length}`);
  assert.equal(f.processed()[0].note, note, 'the verbatim record is untouched');

  // Even when the compressed row still cannot hold the note, the note keeps at
  // least 40 chars and says it was clipped; the pointer is never sacrificed.
  const long = '要参考那个学生的那个页面啊，有些列你要加上筛选啊，'.repeat(4)
  const g = project();
  seed(g.queue('s1'), record('t1', { note: long, ...place }));

  const gOut = await run(CLAIM, claimArgs(g, 's1'));
  assert.equal(gOut.code, 0, gOut.err);
  const gRow = digestLines(gOut.out)[0];
  const body = /— (.*?)  \[e:1\/w:-\]$/.exec(gRow);
  assert.ok(body, `the row keeps the pointer: ${gRow}`);
  assert.ok(body[1].length >= 40, `the note keeps >=40 chars, got ${body[1].length}: ${gRow}`);
  assert.ok(body[1].endsWith('…'), `a clipped note says so: ${gRow}`);
  assert.ok(gRow.length <= 120, `the row stays <=120 chars, was ${gRow.length}`);
});

test('T5 --json is byte-identical to the pre-ledger claim output', async () => {
  const f = project();
  seed(f.queue('s1'), record('q1'), record('q2'));
  seed(f.inbox, record('b1'));

  const now = await run(CLAIM, [...claimArgs(f, 's1'), '--json']);
  assert.equal(now.code, 0, now.err);
  const items = JSON.parse(now.out);
  assert.deepEqual(items.map((i) => i.id), ['q1', 'q2', 'b1'], 'delivery order');
  assert.equal(items[0].id, 'q1');
  assert.equal(now.out, `${JSON.stringify(items, null, 2)}\n`, 'plain JSON.stringify(items, null, 2)');

  const oldProject = project();
  seed(oldProject.queue('s1'), record('q1'), record('q2'));
  seed(oldProject.inbox, record('b1'));
  const before = await run(OLD_CLAIM, ['--inbox', oldProject.inbox, '--queue', 's1', '--session', 's1']);
  assert.equal(before.code, 0, before.err);
  assert.equal(now.out, before.out, '--json must not drift from the shipped claim output');
});

// T6 — v4: debt is printed, never enforced

test('T6 an unsettled batch never blocks delivery (watch exits 0, claim still drains)', async () => {
  const f = project();
  seed(f.queue('s1'), record('q1'));
  const first = await run(CLAIM, claimArgs(f, 's1'));
  assert.equal(first.code, 0, first.err);
  const a = batchIdOf(first.out);

  append(f.queue('s1'), record('q2'), record('q3'));

  // The watcher's only job is to say "there is work"; debt is a stderr summary.
  const w = await run(WATCH, claimArgs(f, 's1'));
  assert.equal(w.code, 0, `watch must not gate: ${w.err}${w.out}`);
  assert.match(w.out, /wake: queue already has 2 pending/);
  assert.match(w.err, /未结清 1 项/);
  assert.equal(readFileSync(f.queue('s1'), 'utf8').split('\n').filter(Boolean).length, 2, 'watch never drains');

  const second = await run(CLAIM, claimArgs(f, 's1'));
  assert.equal(second.code, 0, `claim must deliver while a batch is open: ${second.err}`);
  const b = batchIdOf(second.out);
  assert.notEqual(b, a, 'a new claim is a new batch');
  assert.equal(f.ledgers().length, 2);
  assert.deepEqual(f.claims().map((c) => c.batchId), [a, b]);

  // The debt is in the header, before the digest, with one ack command per item —
  // and never a shortcut that would let an agent fake completion.
  const header = second.out.slice(0, second.out.indexOf('\n1. '));
  assert.ok(second.out.indexOf('## 未结清') > 0 && second.out.indexOf('## 未结清') < second.out.indexOf('\n1. '), 'debt block precedes the digest');
  assert.match(header, new RegExp(`- ${a}#1 \\[open\\]`));
  assert.match(header, new RegExp(`ack --batch ${a} --seq 1 --status done --note`));
  assert.ok(!second.out.includes('--all-done'), 'never teach the fake-completion shortcut');
  assert.ok(!second.out.includes('--force'), 'v4 has no force escape hatch');
});

// T7 — ack settles the ledger, and settlement is what report reads

test('T7 --all-done settles a batch and report goes green', async () => {
  const f = project();
  seed(f.queue('s1'), record('q1'), record('q2'));
  const first = await run(CLAIM, claimArgs(f, 's1'));
  const a = batchIdOf(first.out);

  const ack = await cli(f, 'ack', '--batch', a, '--all-done', '--note', '本批都改完了');
  assert.equal(ack.code, 0, ack.err);
  assert.match(ack.out, /2 项更新/);
  assert.match(ack.out, /已结清/);

  const ledger = ledgerOf(f, a);
  assert.deepEqual(ledger.items.map((i) => i.status), ['done', 'done']);
  assert.ok(Number.isFinite(ledger.closedAt), 'closedAt is stamped once');
  assert.equal(ledger.items[0].history.length, 2, 'claim + ack');

  const report = await cli(f, 'report', '--batch', a);
  assert.equal(report.code, 0, `settled rows must exit 0: ${report.out}`);
  assert.ok(!report.out.includes('| !'), 'no unsettled marker');

  append(f.queue('s1'), record('q3'));
  const next = await run(CLAIM, claimArgs(f, 's1'));
  assert.equal(next.code, 0, next.err);
  assert.ok(!/^## 未结清/m.test(next.out), 'a settled batch is not debt');
});

// T8 — ack validation leaves the ledger untouched

test('T8 a bad ack is exit 1 and writes nothing; a repeat ack is a no-op', async () => {
  const f = project();
  seed(f.queue('s1'), record('q1'));
  const first = await run(CLAIM, claimArgs(f, 's1'));
  const a = batchIdOf(first.out);
  const before = readFileSync(f.ledger(a), 'utf8');

  const noReason = await cli(f, 'ack', '--batch', a, '--seq', '1', '--status', 'wontfix');
  assert.equal(noReason.code, 1);
  assert.match(noReason.err, /--reason is required/);
  const noNote = await cli(f, 'ack', '--batch', a, '--seq', '1');
  assert.equal(noNote.code, 1);
  assert.match(noNote.err, /--note is required/);
  const outOfRange = await cli(f, 'ack', '--batch', a, '--seq', '99', '--note', 'x');
  assert.equal(outOfRange.code, 1);
  assert.match(outOfRange.err, /has 1 items \(seq 1\.\.1\)/);
  assert.equal(readFileSync(f.ledger(a), 'utf8'), before, 'no failed ack may touch the ledger');

  const ok = await cli(f, 'ack', '--batch', a, '--seq', '1', '--note', '按钮 min-width 96px');
  assert.equal(ok.code, 0, ok.err);
  const after = ledgerOf(f, a);
  assert.equal(after.items[0].status, 'done');
  const repeat = await cli(f, 'ack', '--batch', a, '--seq', '1', '--note', '按钮 min-width 96px');
  assert.equal(repeat.code, 0, repeat.err);
  assert.match(repeat.out, /0 项更新/);
  assert.equal(ledgerOf(f, a).items[0].history.length, after.items[0].history.length, 'idempotent: no second history entry');
});

// T9 — blocked/deferred are answers, not gates

test('T9 blocked/deferred do not block the next delivery but are re-surfaced', async () => {
  const f = project();
  seed(f.queue('s1'), record('q1'), record('q2'));
  const first = await run(CLAIM, claimArgs(f, 's1'));
  const a = batchIdOf(first.out);

  assert.equal((await cli(f, 'ack', '--batch', a, '--seq', '1', '--status', 'blocked', '--reason', '等设计给新文案')).code, 0);
  assert.equal((await cli(f, 'ack', '--batch', a, '--seq', '2', '--status', 'deferred', '--reason', '下个迭代做')).code, 0);

  append(f.queue('s1'), record('q3'));
  const next = await run(CLAIM, claimArgs(f, 's1'));
  assert.equal(next.code, 0, `blocked/deferred must not gate: ${next.err}`);
  const header = next.out.slice(0, next.out.indexOf('\n1. '));
  assert.match(header, new RegExp(`- ${a}#1 \\[blocked\\]`));
  assert.match(header, new RegExp(`- ${a}#2 \\[deferred\\]`));
  assert.equal(digestLines(next.out).length, 1, 'the new batch only re-delivers the new item');
});

// T10 — v4: --force is gone, and nothing prints a shortcut

test('T10 --force is inert and no batch is ever marked stale to make room', async () => {
  const f = project();
  seed(f.queue('s1'), record('q1'));
  const first = await run(CLAIM, claimArgs(f, 's1'));
  const a = batchIdOf(first.out);
  append(f.queue('s1'), record('q2'));

  const forced = await run(CLAIM, [...claimArgs(f, 's1'), '--force']);
  assert.equal(forced.code, 0, forced.err);
  assert.ok(!forced.out.includes('--force'), 'the header never advertises the dead flag');
  const b = batchIdOf(forced.out);
  assert.notEqual(b, a);
  assert.deepEqual(ledgerOf(f, a).items.map((i) => i.status), ['open'], 'an earlier batch is never rewritten by a delivery');
  assert.deepEqual(ledgerOf(f, a).forced, []);
  assert.equal(f.claims().at(-1).forced, undefined, 'claims.jsonl records no forced fields');
});

// T11 — TTL is a report label, never a delivery qualifier

test('T11 --open-ttl only decides how an aged open row is shown', async () => {
  const f = project();
  seed(f.queue('s1'), record('q1'));
  const first = await run(CLAIM, claimArgs(f, 's1'));
  const a = batchIdOf(first.out);
  append(f.queue('s1'), record('q2'));

  const second = await run(CLAIM, [...claimArgs(f, 's1'), '--open-ttl', '1']);
  assert.equal(second.code, 0, `ttl is not a delivery condition: ${second.err}`);
  assert.ok(batchIdOf(second.out));
  assert.equal(ledgerOf(f, a).items[0].status, 'open', 'no code path rewrites another batch to stale');

  const aged = await cli(f, 'report', '--batch', a, '--open-ttl', '1');
  assert.equal(aged.code, 3);
  assert.match(aged.out, /\| !1 \|/);
  assert.match(aged.out, /stale/);
  const fresh = await cli(f, 'report', '--batch', a, '--open-ttl', '0');
  assert.equal(fresh.code, 3);
  assert.match(fresh.out, /\| !1 \|/);
  assert.match(fresh.out, /\| open \|/);

  const ttl1 = JSON.parse((await cli(f, 'batches', '--open-ttl', '1', '--json')).out);
  const ttl0 = JSON.parse((await cli(f, 'batches', '--open-ttl', '0', '--json')).out);
  const openOf = (snap, id) => snap.batches.find((x) => x.id === id).open;
  assert.equal(openOf(ttl1, a), 0, 'an aged open item is not counted as open');
  assert.equal(openOf(ttl0, a), 1, '0 = never ages out');
});

// T12 — report: rows === total, `!` on debt, exit 3 while debt remains

test('T12 report prints one row per item and flags the unsettled ones', async () => {
  const f = project();
  seed(f.queue('s1'), record('q1'), record('q2'));
  seed(f.inbox, record('b1', { url: 'http://localhost:5173/settings' }));
  const first = await run(CLAIM, claimArgs(f, 's1'));
  const a = batchIdOf(first.out);

  const out = await cli(f, 'report', '--batch', a);
  assert.equal(out.code, 3, out.out);
  assert.equal(tableRows(out.out).length, ledgerOf(f, a).total, 'rows === total');
  assert.match(out.out, /⚠ 3 行未结清（seq 1, 2, 3）/);
  for (const n of [1, 2, 3]) assert.ok(out.out.includes(`| !${n} |`), `seq ${n} is marked unsettled`);
  assert.match(out.out, /3 行（= total）· open 3/);

  const json = JSON.parse((await cli(f, 'report', '--batch', a, '--json')).out);
  assert.equal(json.rows.length, json.total);
  assert.deepEqual(json.rollup, { open: 3, done: 0, wontfix: 0, blocked: 0, deferred: 0, stale: 0 });

  assert.equal((await cli(f, 'ack', '--batch', a, '--all-done', '--note', '都改完了')).code, 0);
  const green = await cli(f, 'report', '--batch', a);
  assert.equal(green.code, 0, green.out);
  assert.ok(!green.out.includes('| !'), 'nothing unsettled is left');
});

// T13 — batches lists the index newest-first

test('T13 batches lists ledgers newest first with the open count', async () => {
  const f = project();
  seed(f.queue('s1'), record('q1'));
  const first = await run(CLAIM, claimArgs(f, 's1'));
  const a = batchIdOf(first.out);
  await sleep(1100); // the id (and `at`) is second-resolution, and the list is by `at`
  append(f.queue('s1'), record('q2'));
  const second = await run(CLAIM, claimArgs(f, 's1'));
  const b = batchIdOf(second.out);
  await cli(f, 'ack', '--batch', a, '--all-done', '--note', '改完了');

  const snap = JSON.parse((await cli(f, 'batches', '--json')).out);
  assert.deepEqual(snap.batches.map((x) => x.id), [b, a], 'newest first');
  assert.equal(snap.batches[0].open, 1);
  assert.equal(snap.batches[1].open, 0, 'an aged... no, a settled batch counts 0');
  assert.equal(snap.batches[0].sessionId, 's1');
  assert.equal(snap.batches[0].total, 1);

  const text = await cli(f, 'batches');
  assert.equal(text.code, 0, text.err);
  assert.match(text.out, /2 个账本|2 个/);
  assert.ok(text.out.indexOf(b) < text.out.indexOf(a), 'newest first in the table too');
});

// T14 — show re-prints the ledger and the raw record

test('T14 show --evidence is the processed line, show --json is the ledger file', async () => {
  const f = project();
  seed(f.queue('s1'), record('q1'), record('q2'));
  const first = await run(CLAIM, claimArgs(f, 's1'));
  const a = batchIdOf(first.out);

  const evidence = await cli(f, 'show', '--batch', a, '--seq', '2', '--evidence');
  assert.equal(evidence.code, 0, evidence.err);
  const raw = readFileSync(join(f.vibepin, 'processed.jsonl'), 'utf8').trim().split('\n')[1];
  assert.equal(evidence.out.trim(), raw, 'verbatim processed.jsonl line');

  const json = await cli(f, 'show', '--batch', a, '--json');
  assert.equal(json.code, 0, json.err);
  assert.equal(json.out.trim(), readFileSync(f.ledger(a), 'utf8').trim(), 'the ledger file, verbatim');

  const digest = await cli(f, 'show', '--batch', a);
  assert.equal(digest.out.trim().split('\n').filter((l) => /^\d+\. /.test(l)).length, 2);
  assert.match(digest.out, /\[open\]/, 'show suffixes the status');
});

// T15 — the ledger is a projection and can be rebuilt

test('T15 a missing ledger is rebuilt as visible debt, never guessed away', async () => {
  const f = project();
  seed(f.queue('s1'), record('q1'), record('q2'));
  const first = await run(CLAIM, claimArgs(f, 's1'));
  const a = batchIdOf(first.out);

  rmSync(f.ledger(a));
  const rebuilt = await cli(f, 'report', '--batch', a, '--rebuild');
  assert.equal(rebuilt.code, 3, rebuilt.out);
  assert.match(rebuilt.out, /重建/);
  assert.equal(tableRows(rebuilt.out).length, 2, 'rows === the ids claims.jsonl recorded');
  assert.ok(existsSync(f.ledger(a)), 'the ledger is written back');

  const ledger = ledgerOf(f, a);
  assert.equal(ledger.rebuilt, true);
  assert.deepEqual(ledger.items.map((i) => i.status), ['stale', 'stale'], 'a lost ledger is debt, not success');
  assert.deepEqual(ledger.items.map((i) => i.history[0].reason), ['ledger-missing', 'ledger-missing']);
  assert.deepEqual(ledger.items.map((i) => i.id), ['q1', 'q2']);

  const ghost = await cli(f, 'report', '--batch', 'b-20200101-000000-0000', '--rebuild');
  assert.equal(ghost.code, 1);
  assert.match(ghost.err, /unknown batch/);
});

// T15b — a missing ledger that claims.jsonl can rebuild is debt with a way out, not
// an unknown batch: report/ack must point at --rebuild instead of denying the batch,
// and neither may write anything unless --rebuild was actually asked for.

test('T15b a missing ledger that claims.jsonl knows is "rebuild me", never "unknown"', async () => {
  const f = project();
  seed(f.queue('s1'), record('r1'), record('r2'));
  const first = await run(CLAIM, claimArgs(f, 's1'));
  assert.equal(first.code, 0, first.err);
  const a = batchIdOf(first.out);
  rmSync(f.ledger(a));

  const report = await cli(f, 'report', '--batch', a);
  assert.equal(report.code, 1);
  assert.doesNotMatch(report.out + report.err, /unknown batch/, 'a rebuildable batch is not unknown');
  assert.match(report.out + report.err, /--rebuild/, 'the message names the way out');
  assert.ok(!existsSync(f.ledger(a)), 'report without --rebuild writes nothing');

  const ack = await cli(f, 'ack', '--batch', a, '--seq', '1', '--note', 'x');
  assert.equal(ack.code, 1);
  assert.doesNotMatch(ack.out + ack.err, /unknown batch/, 'ack uses the same口径 as report');
  assert.match(ack.out + ack.err, /--rebuild/);
  assert.ok(!existsSync(f.ledger(a)), 'ack without --rebuild writes nothing either');

  const rebuilt = await cli(f, 'ack', '--batch', a, '--seq', '1', '--note', '重建后结清', '--rebuild');
  assert.equal(rebuilt.code, 0, rebuilt.err + rebuilt.out);
  assert.match(rebuilt.out, /重建/);
  assert.ok(existsSync(f.ledger(a)), '--rebuild is the way through');

  const ghost = await cli(f, 'ack', '--batch', 'b-20200101-000000-0000', '--seq', '1', '--note', 'x', '--rebuild');
  assert.equal(ghost.code, 1);
  assert.match(ghost.err, /unknown batch/, 'a batch nobody ever claimed stays unknown');
});

// T16 — records written before the protocol stay deliverable

test('T16 a record without a batch field delivers as 无批号', async () => {
  const f = project();
  seed(f.queue('s1'), record('legacy-1'));

  const out = await run(CLAIM, [...claimArgs(f, 's1'), '--full']);
  assert.equal(out.code, 0, out.err);
  const a = batchIdOf(out.out);
  assert.match(out.out, /无批号×1/);
  assert.match(out.out, /\[e:\d+\/w:-\]/, 'no write batch prints as /-');
  assert.deepEqual(ledgerOf(f, a).writeBatches, [{ id: null, count: 1 }]);
  const payload = JSON.parse(out.out.slice(out.out.indexOf('\n[\n') + 1));
  assert.equal(payload[0].batch, undefined, 'the record itself is untouched');
});

// T17 — an empty batch stays the canonical []

test('T17 an empty claim prints [] and opens no ledger, even with debt around', async () => {
  const f = project();
  seed(f.queue('s1'), record('q1'));
  const first = await run(CLAIM, claimArgs(f, 's1'));
  assert.ok(batchIdOf(first.out));

  const empty = await run(CLAIM, claimArgs(f, 's1'));
  assert.equal(empty.code, 0, empty.err);
  assert.equal(empty.out, '[]\n');
  assert.equal(f.ledgers().length, 1, 'no ledger is opened for nothing');
});

// T18 — v4: a broken ledger cannot stop the pipeline

test('T18 an unreadable ledger is skipped (fail-open), never a delivery failure', async () => {
  const f = project();
  seed(f.queue('s1'), record('q1'));
  const first = await run(CLAIM, claimArgs(f, 's1'));
  const a = batchIdOf(first.out);
  writeFileSync(f.ledger(a), '{ this is not json', 'utf8');
  append(f.queue('s1'), record('q2'));

  const w = await run(WATCH, claimArgs(f, 's1'));
  assert.equal(w.code, 0, `a corrupt ledger must never change a wake: ${w.out}${w.err}`);
  assert.match(w.out, /wake: queue already has 1 pending/);
  assert.ok(!w.err.includes('未结清'), 'nothing can be claimed about a ledger that does not parse');

  const out = await run(CLAIM, claimArgs(f, 's1'));
  assert.equal(out.code, 0, `claim still delivers: ${out.err}`);
  const b = batchIdOf(out.out);
  assert.notEqual(b, a);
  assert.equal(f.ledgers().length, 2);
});


// ---------------------------------------------------------------------------
// T19 — resolve_annotation settles the *ledger*, not just claims.jsonl

// The defect this guards: resolve_annotation wrote a claims.jsonl line (so the
// note stopped being re-delivered) but never touched the ledger. report reads the
// ledger's item status, so the note stayed `open` for ever and report never
// reached exit 0 — the comparison table the user checks against lied.

test('T19 resolve_annotation settles the ledger, so report can go green', async () => {
  const f = project();
  seed(f.queue('s1'), record('a1'), record('a2'));
  const out = await run(CLAIM, claimArgs(f, 's1'));
  assert.equal(out.code, 0, out.err);
  const id = batchIdOf(out.out);
  assert.deepEqual(ledgerOf(f, id).items.map((i) => i.status), ['open', 'open']);

  const tools = createToolBindings(createStore(f.inbox), sessionsFake(f.inbox));
  const r = await tools.resolve({ ids: ['a1', 'a2'], sessionId: 's1', note: 'T19 已改 frontend/src/Upload.vue:12' });

  assert.equal(r.settled, 2, 'both ids must be found in the ledger');
  assert.deepEqual(ledgerOf(f, id).items.map((i) => i.status), ['done', 'done']);
  assert.ok(ledgerOf(f, id).closedAt, 'a fully answered batch is closed');

  const rep = await cli(f, 'report', '--batch', id);
  assert.equal(rep.code, 0, `report must go green: ${rep.out}`);
  assert.equal(tableRows(rep.out).filter((l) => l.includes('!')).length, 0);
});

// The note is required by the ledger's own rule (it becomes the 证据 column), and
// the refusal happens before anything is written — never a half-settled batch.
test('T19b resolve_annotation without a note refuses and writes nothing', async () => {
  const f = project();
  seed(f.queue('s1'), record('a1'));
  const out = await run(CLAIM, claimArgs(f, 's1'));
  const id = batchIdOf(out.out);

  const tools = createToolBindings(createStore(f.inbox), sessionsFake(f.inbox));
  await assert.rejects(() => tools.resolve({ ids: ['a1'], sessionId: 's1' }), /note/i);

  assert.deepEqual(ledgerOf(f, id).items.map((i) => i.status), ['open'], 'nothing may be half-settled');
});

// An MCP-only session never claims a batch, so there is no ledger item to settle.
// Settling 0 must be a normal answer, not an error — the claims line is still
// what stops re-delivery.
test('T19c resolve_annotation with no ledger item is a normal zero, not an error', async () => {
  const f = project();
  seed(f.queue('s1'), record('a1'));

  const tools = createToolBindings(createStore(f.inbox), sessionsFake(f.inbox));
  const r = await tools.resolve({ ids: ['a1'], sessionId: 's1', note: 'no batch was ever claimed' });

  assert.equal(r.settled, 0);
  assert.equal(r.resolved, 1, 'the claims line still retires it from pending');
  assert.equal(f.claims().length, 1);
});

// ---------------------------------------------------------------------------
// T19d–T19f — the three hazards the happy-path test could not see
//
// Reviewer C ran 8 mutations against the first version of this fix: 7 slipped past
// T19 + the whole p3 suite. These pin the ones that matter.

// M1 (the worst): `seqs: null` means "every open item", so a one-id resolve that
// widened to it would report work that was never done — the exact fake completion
// the protocol refuses to let the CLI print (`--all-done` is deliberately unlisted).
test('T19d resolve_annotation settles only the ids asked for, never the whole batch', async () => {
  const f = project();
  seed(f.queue('s1'), record('a1'), record('a2'), record('a3'));
  const out = await run(CLAIM, claimArgs(f, 's1'));
  const id = batchIdOf(out.out);

  const tools = createToolBindings(createStore(f.inbox), sessionsFake(f.inbox));
  const r = await tools.resolve({ ids: ['a1'], sessionId: 's1', note: '只改了 a1' });

  assert.equal(r.settled, 1);
  assert.deepEqual(ledgerOf(f, id).items.map((i) => i.status), ['done', 'open', 'open']);
  const rep = await cli(f, 'report', '--batch', id);
  assert.equal(rep.code, 3, 'two items are still unanswered');
  assert.equal(tableRows(rep.out).filter((l) => l.includes('!')).length, 2);
});

// M4b: the note is the whole point of the receipt — it becomes the 证据 column the
// user checks the change against. Nothing asserted it reached the ledger.
test('T19e the note becomes the 证据 column, verbatim — not a timestamp', async () => {
  const f = project();
  seed(f.queue('s1'), record('a1'));
  const out = await run(CLAIM, claimArgs(f, 's1'));
  const id = batchIdOf(out.out);
  const note = '已改 frontend/src/Upload.vue:131';

  const tools = createToolBindings(createStore(f.inbox), sessionsFake(f.inbox));
  await tools.resolve({ ids: ['a1'], sessionId: 's1', note });

  assert.equal(ledgerOf(f, id).items[0].history.at(-1).note, note);
  const rep = await cli(f, 'report', '--batch', id);
  assert.ok(rep.out.includes(note), `the report must carry it as evidence:\n${rep.out}`);
});

// A verdict is not this caller's to overturn. `wontfix` exists precisely so "not a
// bug, by design" survives someone later deciding to change it anyway.
test('T19f resolve_annotation never overwrites an existing verdict', async () => {
  const f = project();
  seed(f.queue('s1'), record('a1'));
  const out = await run(CLAIM, claimArgs(f, 's1'));
  const id = batchIdOf(out.out);

  const ruled = await cli(f, 'ack', '--batch', id, '--seq', '1', '--status', 'wontfix', '--reason', 'by design, not a bug');
  assert.equal(ruled.code, 0, ruled.err);
  assert.deepEqual(ledgerOf(f, id).items.map((i) => i.status), ['wontfix']);

  const tools = createToolBindings(createStore(f.inbox), sessionsFake(f.inbox));
  const r = await tools.resolve({ ids: ['a1'], sessionId: 's1', note: 'I changed it anyway' });

  assert.equal(r.settled, 0, 'nothing may be settled');
  assert.equal(r.skipped, 1, 'but it must be reported, not silently dropped');
  assert.deepEqual(ledgerOf(f, id).items.map((i) => i.status), ['wontfix'], 'the verdict must stand');
  assert.notEqual(ledgerOf(f, id).items[0].history.at(-1).note, 'I changed it anyway');
  assert.equal((await cli(f, 'report', '--batch', id)).code, 0, 'a wontfix batch is a closed batch');
});

// Gap 2: nothing covered a resolve that spans more than one batch, so an
// implementation that settled only the first ledger would pass the whole suite.
test('T19g a resolve spanning two batches settles both', async () => {
  const f = project();
  seed(f.queue('s1'), record('a1'));
  const o1 = await run(CLAIM, claimArgs(f, 's1'));
  const id1 = batchIdOf(o1.out);
  seed(f.queue('s1'), record('a2'));
  const o2 = await run(CLAIM, claimArgs(f, 's1'));
  const id2 = batchIdOf(o2.out);
  assert.notEqual(id1, id2, 'the fixture needs two distinct batches');

  const tools = createToolBindings(createStore(f.inbox), sessionsFake(f.inbox));
  const r = await tools.resolve({ ids: ['a1', 'a2'], sessionId: 's1', note: '两批都改了' });

  assert.equal(r.settled, 2);
  assert.deepEqual(ledgerOf(f, id1).items.map((i) => i.status), ['done']);
  assert.deepEqual(ledgerOf(f, id2).items.map((i) => i.status), ['done']);
  assert.equal((await cli(f, 'report', '--batch', id1)).code, 0);
  assert.equal((await cli(f, 'report', '--batch', id2)).code, 0);
});
