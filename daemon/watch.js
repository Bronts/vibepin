#!/usr/bin/env node
// Block until there is work to claim, then exit 0 — the "wake primitive".
// The harness runs it as a background job (0 tokens while it waits) and
// re-invokes the agent in the same session when it exits.
//
//   node watch.js --inbox <proj>/.vibepin/inbox.jsonl \
//        [--queue <proj>/.vibepin/sessions/<sid>.jsonl] [--session <sid>] \
//        [--label "改简历解析页"] [--agent omp]
//
// Zero deps (no fswatch needed): fs.watchFile polling, which is reliable across
// editors and atomic-rename writers where fs.watch can miss events.
//
// §7.1 fixes: the baseline is {size,mtimeMs,ino} per watched file (the old
// `curr.size > start` counter went permanently blind when a file shrank after a
// claim, and folded every stat error into "no annotations yet"); a non-empty
// --queue exits immediately instead of parking; both files are unwatched on the
// way out; unusable files exit non-zero with a diagnostic.

import { statSync, watchFile, unwatchFile, utimesSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { assertIsFile, createStore, resolveQueue, resolveSessionId, sessionPaths, writeLease } from './store.js';

const argv = process.argv;
const flag = (name) => { const i = argv.indexOf(name); return i !== -1 ? argv[i + 1] : undefined; };

function die(message, code = 1) {
  process.stderr.write(`[vibepin] ${message}\n`);
  process.exit(code);
}

// A value-less option must fail loudly: silently watching the default inbox when
// the caller meant a specific one is the kind of silent mis-watch we are fixing.
for (const name of ['--inbox', '--queue', '--session']) {
  if (argv.includes(name) && (!flag(name) || flag(name).startsWith('--'))) die(`${name} needs a value`);
}

const INBOX = resolve(flag('--inbox') || process.env.ANNOTATE_INBOX || join(process.cwd(), '.vibepin', 'inbox.jsonl'));
const TIMEOUT_MS = Number(process.env.ANNOTATE_WATCH_TIMEOUT || 0); // 0 = no timeout
const AGENT = flag('--agent') || process.env.VPIN_AGENT || 'cli';
const LABEL = flag('--label');

let SID, QUEUE, LEASE;
try {
  SID = resolveSessionId(INBOX, { queue: flag('--queue'), session: flag('--session') });
  QUEUE = resolveQueue(INBOX, flag('--queue'));
  LEASE = SID ? sessionPaths(INBOX, SID).lease : null;
  assertIsFile(INBOX, '--inbox');
  if (QUEUE) assertIsFile(QUEUE, '--queue');
} catch (e) {
  die(e.message);
}

const FILES = [...new Set([QUEUE, INBOX].filter(Boolean))];
const store = createStore(INBOX);

// ENOENT is "not created yet" (§7.1 fix 5) only when the nearest existing
// ancestor is a directory: on Windows stat also reports ENOENT when an ancestor
// is a plain file (POSIX ENOTDIR), and that path can never come into existence —
// parking on it would be exactly the blindness §7.1 is fixing.
function absentIsNormal(file) {
  for (let dir = dirname(resolve(file));;) {
    let st;
    try {
      st = statSync(dir);
    } catch (e) {
      if (e.code !== 'ENOENT') return false;
      const up = dirname(dir);
      if (up === dir) return true; // walked up to the fs root: nothing is in the way
      dir = up;
      continue;
    }
    return st.isDirectory();
  }
}

function signature(file) {
  try {
    const s = statSync(file);
    return { size: s.size, mtimeMs: s.mtimeMs, ino: s.ino };
  } catch (e) {
    if (e.code === 'ENOENT' && absentIsNormal(file)) return null;
    die(`cannot stat ${file}: ${e.code || e.message} — a watcher that cannot read its file looks exactly like an idle one; exiting non-zero for the turn to see`, 2);
  }
}

const sigKey = (s) => (s === null ? 'missing' : `${s.size}B mtime=${s.mtimeMs} ino=${s.ino}`);

// fs.watchFile hands the callback the Stats it already read, and zeroes them when
// the path cannot be stat'd (§7.1). Deriving the "after" key from that instead of
// from a second statSync removes a race: a fresh stat can still see ENOENT for a
// file the watcher has just seen created (observed on Windows), which would park
// the watcher until something else moved the file — and it would print a bogus
// `missing → missing` wake.
const keyOfStat = (s) => (s.size === 0 && s.mtimeMs === 0 && s.ino === 0 ? 'missing' : sigKey(s));

let heartbeat = null;
let armed = false;

function done(reason) {
  armed = false;
  for (const f of FILES) unwatchFile(f); // §7.1 fix 4: every watched file
  clearInterval(heartbeat);
  console.log(`[vibepin] wake: ${reason}`);
  process.exit(0);
}

async function main() {
  // The lease is what makes this session a routing target (§4.2). It is written
  // before parking; its mtime is then refreshed with utimes() — a heartbeat that
  // costs nothing and needs no network (§6.1), and only ever affects display.
  if (SID) {
    await writeLease(INBOX, SID, (prev) => ({
      agent: AGENT,
      ...(LABEL ? { label: LABEL } : {}),
      pid: process.ppid,
      watcherPid: process.pid,
      cwd: process.cwd(),
      mode: 'file',
      startedAt: prev.startedAt,
      lastReArmAt: Date.now(),
    }));
  }

  // §7.1 fix 2: backlog in our own queue means "wake now" — parking with pending
  // work would idle until some later change and misattribute the wake.
  let queuePending = 0;
  if (QUEUE) {
    queuePending = await store.count(QUEUE);
    if (queuePending > 0) done(`queue already has ${queuePending} pending`);
  }

  // Arm every file before comparing: a change landing between the two stats is
  // caught by the second one, and anything after it is caught by watchFile — so
  // there is no window in which a change can be missed.
  const before = new Map(FILES.map((f) => [f, signature(f)]));
  const base = new Map();
  for (const file of FILES) {
    watchFile(file, { interval: 400 }, (curr) => {
      if (!armed) return;
      const was = base.get(file);
      const now = keyOfStat(curr);
      // Only a real signature move is a wake: fs.watchFile can deliver an event
      // for a path that does not exist yet (observed on Windows: one event right
      // after arming, with the file still absent — it used to wake every fresh
      // watcher instantly). Absent → absent is a stable baseline; absent →
      // present is a change.
      if (now === was) return;
      done(`${file} changed (${was} → ${now})`);
    });
    base.set(file, sigKey(signature(file)));
    if (base.get(file) !== sigKey(before.get(file))) {
      done(`${file} changed while arming (${sigKey(before.get(file))} → ${base.get(file)})`);
    }
  }
  armed = true;

  if (TIMEOUT_MS > 0) setTimeout(() => done(`timeout after ${TIMEOUT_MS}ms (re-arm)`), TIMEOUT_MS);

  const bytes = (file) => (signature(file) || { size: 0 }).size;
  console.log(`[vibepin] watching ${INBOX} (from ${bytes(INBOX)} bytes) …`);
  if (QUEUE) console.log(`[vibepin] watching ${QUEUE} (${queuePending} pending) …`);
  if (SID) console.log(`[vibepin] session ${SID} (lease ${LEASE}) …`);

  if (SID) {
    heartbeat = setInterval(() => {
      try { const now = new Date(); utimesSync(LEASE, now, now); } catch { /* display-only */ }
    }, 20000);
  }
}

main().catch((e) => {
  process.stderr.write(`[vibepin] watch failed: ${e.stack || e}\n`);
  process.exit(1);
});
