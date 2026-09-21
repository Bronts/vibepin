#!/usr/bin/env node
// Claim pending annotations, open a batch ledger and print the delivery header.
//
//   node claim.js --inbox <proj>/.vibepin/inbox.jsonl \
//        [--queue <proj>/.vibepin/sessions/<sid>.jsonl] [--session <sid>] [--recover]
//        [--ledger] [--full] [--json] [--open-ttl <ms>]
//
// Per file: rename <file> -> <file>.claiming (atomic, so new POSTs start a fresh
// file), read it, append it to processed.jsonl, unlink it. Repeat until the file
// is gone, so annotations that land mid-read are not left behind. The watcher is
// not running while this happens, which is why there is no race.
//
// §7.2 fixes: every file is claimed independently (the old code returned as soon
// as the FIRST file was missing, so with a session queue + shared inbox the second
// file never drained); an orphan .claiming left by an interrupted claim is
// archived and reported instead of being silently destroyed by the next rename;
// the archive dir comes from the SHARED inbox, never from --queue.
//
// Fail-open (the v4 ruling, which overrides the v3 draft's gate): this script
// NEVER exits non-zero because an earlier batch is unsettled, and there is no
// --force. An ack is bookkeeping, not a delivery condition — refusing to deliver
// because a note is unanswered would strand every later note on that session.
// Outstanding items surface as the `## 未结清` block in the delivery header
// (default, --full and `vibepin report`), one `vibepin ack` line each.
//
// Output (v4.1 — the default is the instruction layer, not the payload):
//   default      header + retrieval hint + ## 未结清 + digest, sized to
//                DELIVERY_CHAR_MAX (3000 chars): no JSON is inlined, and the
//                evidence layer is one `show --seq <n> --evidence` away
//   --full       the v4 default shape, kept for debugging: header + ## 未结清 +
//                digest (unbounded) + the full JSON array
//   --json       the JSON array only, byte-identical to what this script printed
//                before the ledger existed
//   no --session and no --ledger: the bare array as well — the legacy broadcast
//                usage is pinned byte-for-byte by tests/p0-session-routing.test.mjs
//   empty batch  [] (and no ledger is created)
//
// --brief is gone: the instruction layer IS the default now, so a second flag for
// it would be a synonym. It dies loudly instead of being silently ignored, so a
// stale harness is told to switch to --full.
//
// --recover only recovers orphans and does not drain live queues: the manual
// recovery channel for a session that crashed mid-claim. It is not gated either —
// an interrupted claim is "the last batch was not delivered", not "the next one".

import { appendFile, mkdir, rename, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import {
  assertIsFile, pathsFor, resolveQueue, resolveSessionId, sessionPaths, writeLease,
  readJsonlLines, parseItem, claimedIdSet,
} from './store.js';
import {
  carryOver, createBatch, formatDigest, formatHeader, formatInstructionLayer, formatUnsettled, openTtlMs,
} from './batches.js';

const argv = process.argv;
const flag = (name) => { const i = argv.indexOf(name); return i !== -1 ? argv[i + 1] : undefined; };

function die(message, code = 1) {
  process.stderr.write(`[vibepin] ${message}\n`);
  process.exit(code);
}

// A value-less option must fail loudly: silently claiming the default inbox when
// the caller meant a specific one is the kind of silent mis-read we are fixing.
for (const name of ['--inbox', '--queue', '--session', '--open-ttl']) {
  if (argv.includes(name) && (!flag(name) || flag(name).startsWith('--'))) die(`${name} needs a value`);
}
if (argv.includes('--full') && argv.includes('--json')) die('--full and --json are mutually exclusive');
// A removed flag must fail loudly: silently ignoring a stale --brief would hide
// that the caller is on the v4 shape and never sees the new instruction layer.
if (argv.includes('--brief')) die('--brief is gone — the default output is the instruction layer now; use --full for the whole JSON array');

const INBOX = resolve(flag('--inbox') || process.env.ANNOTATE_INBOX || join(process.cwd(), '.vibepin', 'inbox.jsonl'));
const RECOVER_ONLY = argv.includes('--recover');
// --ledger opens a ledger for the session-less usage too (`claim --inbox X
// --ledger`), where there is no `ack` subject to derive "the latest batch" from.
const LEDGER = argv.includes('--ledger');
const FULL = argv.includes('--full');
const JSON_ONLY = argv.includes('--json');
const { processed: PROCESSED, claims: CLAIMS } = pathsFor(INBOX);

let TTL;
try {
  TTL = openTtlMs(flag('--open-ttl'));
} catch (e) {
  die(e.message);
}

let SID, QUEUE;
try {
  SID = resolveSessionId(INBOX, { queue: flag('--queue'), session: flag('--session') });
  QUEUE = resolveQueue(INBOX, flag('--queue'));
  assertIsFile(INBOX, '--inbox');
  if (QUEUE) assertIsFile(QUEUE, '--queue');
} catch (e) {
  die(e.message);
}

const CLAIMING = '.claiming';

async function archive(lines) {
  await mkdir(dirname(PROCESSED), { recursive: true });
  await appendFile(PROCESSED, lines.join('\n') + '\n', 'utf8');
}

// Ids already accounted for (MCP resolve_annotation, or an earlier claim) must not
// be delivered again: the whole point of claims.jsonl is that queues are never
// rewritten, so a handled line can still be sitting in a queue file.
//
// `delivered` is the same rule within one run: an id that exists in both the
// session queue and the shared inbox is one annotation, so the copy claimed second
// is neither delivered nor archived twice (§7.2 #3). The queue is claimed first,
// so its copy is the one that survives.
const delivered = new Set();

async function keepFresh(lines) {
  const claimed = await claimedIdSet(CLAIMS);
  const out = [];
  for (const line of lines) {
    const it = parseItem(line);
    if (it.id !== undefined) {
      if (claimed.has(it.id) || delivered.has(it.id)) continue;
      delivered.add(it.id);
    }
    out.push(line);
  }
  return out;
}

// Every delivered line carries where it came from, because the ledger records it
// per item (sources.queue + sources.inbox === total, and recovered is the subset
// that came out of an interrupted claim).
const from = (lines, role, recovered) => lines.map((line) => ({ line, role, recovered }));

// A leftover <file>.claiming is a batch whose claim died between the rename and
// the archive. It was never printed (the print happens last), so it is recovered
// and delivered rather than overwritten by the next rename.
async function recover(file, role) {
  const orphan = file + CLAIMING;
  const lines = await readJsonlLines(orphan); // absent -> []
  if (!lines.length) {
    await unlink(orphan).catch(() => {});
    return [];
  }
  const fresh = await keepFresh(lines);
  await unlink(orphan);
  if (!fresh.length) {
    process.stderr.write(`[vibepin] dropped ${lines.length} line(s) of an interrupted claim on ${file} that were already delivered or claimed\n`);
    return [];
  }
  await archive(fresh);
  const ids = fresh.map((line) => parseItem(line).id).filter((id) => id !== undefined);
  process.stderr.write(`[vibepin] recovered ${fresh.length} annotation(s) from an interrupted claim on ${file}: ${ids.join(', ') || '(no ids)'}\n`);
  return from(fresh, role, true);
}

async function drain(file, role) {
  const out = [];
  for (;;) {
    let lines;
    try {
      await rename(file, file + CLAIMING);
      lines = await readJsonlLines(file + CLAIMING);
    } catch (e) {
      // ENOENT = this file has nothing left; the other file is unaffected (§7.2).
      if (e.code === 'ENOENT') return out;
      throw e;
    }
    const fresh = await keepFresh(lines);
    if (fresh.length) await archive(fresh);
    await unlink(file + CLAIMING);
    out.push(...from(fresh, role, false));
  }
}

async function claimFile(file, role) {
  try {
    const entries = await recover(file, role);
    if (!RECOVER_ONLY) entries.push(...await drain(file, role));
    return entries;
  } catch (e) {
    die(`cannot claim ${file}: ${e.code || e.message} — annotations are still on disk (a sandbox/permission error is the usual cause); exiting 1`);
  }
}

async function main() {
  // evidence.line must be stable, so the processed.jsonl baseline is taken
  // BEFORE anything is archived: item i of this delivery is archived on line
  // `PROCESSED_START + i + 1` (archive order === delivery order).
  const PROCESSED_START = (await readJsonlLines(PROCESSED)).length;

  // Session queue first, shared inbox second: the queue is the directed channel,
  // the inbox is broadcast (§5.1).
  const entries = [];
  if (QUEUE) entries.push(...await claimFile(QUEUE, 'queue'));
  entries.push(...await claimFile(INBOX, 'inbox'));

  // Order is queue batch first, then the shared inbox; duplicates across the two
  // files were already dropped by keepFresh, so this only has to parse.
  const items = entries.map((e) => parseItem(e.line));
  const origins = entries.map((e) => ({ role: e.role, recovered: e.recovered }));

  const now = Date.now();
  let batch = null;
  if (items.length && (SID || LEDGER)) {
    // One clock read for the ledger, the claims.jsonl line and the lease refresh:
    // they describe the same moment, so a reader can compare them.
    batch = await createBatch({
      inbox: INBOX,
      sessionId: SID ?? null,
      items,
      origins,
      evidenceBase: PROCESSED_START,
      files: [
        ...(QUEUE ? [{ role: 'queue', path: QUEUE }] : []),
        { role: 'inbox', path: INBOX },
      ],
      ttlMs: TTL,
      now,
    });
    const ids = items.map((it) => it.id).filter((id) => id !== undefined);
    if (ids.length) {
      await mkdir(dirname(CLAIMS), { recursive: true });
      // batchId is what makes a ledger rebuildable: without it, claims.jsonl only
      // says "these ids were delivered", not "as batch b-…".
      await appendFile(CLAIMS, `${JSON.stringify({ ids, sessionId: SID ?? null, at: now, batchId: batch.id })}\n`, 'utf8');
    }
  }

  if (SID) {
    // lastClaimAt is a lease refresh, never a creation: a lease that no watcher
    // ever wrote would make this session look routable while nothing watches its
    // queue (§5.3 — that is the silent-loss shape we must avoid).
    const { lease } = sessionPaths(INBOX, SID);
    if (existsSync(lease)) await writeLease(INBOX, SID, { lastClaimAt: now });
    else process.stderr.write(`[vibepin] no lease for ${SID} — run watch.js with --queue/--session so this session is registered\n`);
  }

  const payload = `${JSON.stringify(items, null, 2)}\n`;
  if (!batch || JSON_ONLY) {
    // Legacy usage and the machine contract: the array, and nothing else.
    process.stdout.write(payload);
    return;
  }

  // The debt block goes right after the header and before the digest, so it
  // survives even a truncated stdout — and it never replaces the payload below.
  const carry = await carryOver(INBOX, {
    sessionId: SID ?? null,
    excludeId: batch.id,
    onWarn: (m) => process.stderr.write(`[vibepin] ${m}\n`),
  });
  if (FULL) {
    // The v4 default shape, kept for debugging: the header with its debt note, the
    // itemized `## 未结清`, the raw digest and then the whole JSON array.
    const parts = [formatHeader(batch, { inbox: INBOX, unsettled: carry.length })];
    const debt = formatUnsettled(carry);
    if (debt) parts.push(debt);
    parts.push(formatDigest(batch), payload);
    process.stdout.write(parts.join('\n') + '\n');
    return;
  }
  // v4.1 default: the instruction layer only. formatInstructionLayer owns the
  // budget (header + hint + debt + digest <= 3000 chars); the evidence layer is
  // not deleted, only moved behind `show --batch <id> --seq <n> --evidence`.
  process.stdout.write(`${formatInstructionLayer(batch, { inbox: INBOX, carry, now })}\n`);
}

main().catch((e) => {
  process.stderr.write(`[vibepin] claim failed: ${e.stack || e}\n`);
  process.exit(1);
});
