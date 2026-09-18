#!/usr/bin/env node
// Claim pending annotations and print the batch as a JSON array on stdout.
//
//   node claim.js --inbox <proj>/.vibepin/inbox.jsonl \
//        [--queue <proj>/.vibepin/sessions/<sid>.jsonl] [--session <sid>] [--recover]
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
// --recover only recovers orphans and does not drain live queues: the manual
// recovery channel for a session that crashed mid-claim.

import { appendFile, mkdir, rename, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import {
  assertIsFile, pathsFor, resolveQueue, resolveSessionId, sessionPaths, writeLease,
  readJsonlLines, parseItem, claimedIdSet,
} from './store.js';

const argv = process.argv;
const flag = (name) => { const i = argv.indexOf(name); return i !== -1 ? argv[i + 1] : undefined; };

function die(message, code = 1) {
  process.stderr.write(`[vibepin] ${message}\n`);
  process.exit(code);
}

for (const name of ['--inbox', '--queue', '--session']) {
  if (argv.includes(name) && (!flag(name) || flag(name).startsWith('--'))) die(`${name} needs a value`);
}

const INBOX = resolve(flag('--inbox') || process.env.ANNOTATE_INBOX || join(process.cwd(), '.vibepin', 'inbox.jsonl'));
const RECOVER_ONLY = argv.includes('--recover');
const { processed: PROCESSED, claims: CLAIMS } = pathsFor(INBOX);

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

// A leftover <file>.claiming is a batch whose claim died between the rename and
// the archive. It was never printed (the print happens last), so it is recovered
// and delivered rather than overwritten by the next rename.
async function recover(file) {
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
  return fresh;
}

async function drain(file) {
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
    out.push(...fresh);
  }
}

async function claimFile(file) {
  try {
    const lines = await recover(file);
    if (!RECOVER_ONLY) lines.push(...await drain(file));
    return lines;
  } catch (e) {
    die(`cannot claim ${file}: ${e.code || e.message} — annotations are still on disk (a sandbox/permission error is the usual cause); exiting 1`);
  }
}

async function main() {
  // Session queue first, shared inbox second: the queue is the directed channel,
  // the inbox is broadcast (§5.1).
  const lines = [];
  if (QUEUE) lines.push(...await claimFile(QUEUE));
  lines.push(...await claimFile(INBOX));

  // Order is queue batch first, then the shared inbox; duplicates across the two
  // files were already dropped by keepFresh, so this only has to parse.
  const items = lines.map(parseItem);

  if (SID) {
    // One clock read for both records: the claims.jsonl line and the lease refresh
    // describe the same moment, so a reader can compare them.
    const now = Date.now();
    const ids = items.map((it) => it.id).filter((id) => id !== undefined);
    if (ids.length) {
      await mkdir(dirname(CLAIMS), { recursive: true });
      await appendFile(CLAIMS, `${JSON.stringify({ ids, sessionId: SID, at: now })}\n`, 'utf8');
    }
    // lastClaimAt is a lease refresh, never a creation: a lease that no watcher
    // ever wrote would make this session look routable while nothing watches its
    // queue (§5.3 — that is the silent-loss shape we must avoid).
    const { lease } = sessionPaths(INBOX, SID);
    if (existsSync(lease)) await writeLease(INBOX, SID, { lastClaimAt: now });
    else process.stderr.write(`[vibepin] no lease for ${SID} — run watch.js with --queue/--session so this session is registered\n`);
  }

  process.stdout.write(`${JSON.stringify(items, null, 2)}\n`);
}

main().catch((e) => {
  process.stderr.write(`[vibepin] claim failed: ${e.stack || e}\n`);
  process.exit(1);
});
