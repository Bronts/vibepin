// Batch ledger: the disk state behind "how many arrived, how many were settled"
// (docs/20260919-batch-ledger.md). Zero npm deps; the CLI, claim.js and the
// daemon's write stamp all go through this file, so there is exactly one
// implementation of the format.
//
// Two numbers, never mixed up:
//   write batch  `w-…`  stamped by the daemon onto every record of one POST
//   claim batch  `b-…`  one claim.js run = one ledger file <proj>/.vibepin/batches/<id>.json
//
// The ledger is a PROJECTION, not a lock. Delivery never consults it: watch/claim
// deliver whenever there is work, and the delivery header prints the debt
// (`## 未结清`) instead of refusing (§0.3 / the v4 ruling). A missing or broken
// ledger can only make a report worse — readBatch/listBatches are fail-open.
//
// Writers: claim.js creates a ledger and writes `closedAt`; `vibepin ack` is the
// only writer of item statuses; report/show only read (rebuildBatch is the
// explicit repair). The daemon never touches this directory — nothing a page can
// reach may be able to change the accounting (daemon.js only imports stamp/hex4).

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { pathsFor, readJsonlLines, parseItem, writeJsonAtomic } from './store.js';

export const LEDGER_VERSION = 1;

// "open" is the only unsettled status that means "not answered yet"; blocked and
// deferred carry a reason and are shown every delivery, stale is a visible
// "we knowingly skipped this". None of them is a delivery condition.
export const STATUSES = ['open', 'done', 'wontfix', 'blocked', 'deferred', 'stale'];
export const UNSETTLED_STATUSES = ['open', 'blocked', 'deferred'];
const NOTE_MAX = 160;
const UNSETTLED_LIMIT = 5;         // debt rows printed in the delivery header
const PAGES_LIMIT = 8;             // page summary entries in the header

// v4.1 stdout budget. The default delivery is a command sheet, not a payload
// dump: the evidence layer (selector/html/styles/rect/chain) moves behind
// `show --seq <n> --evidence`, so stdout has to fit a consumer that truncates
// around 4k characters. These are CHARACTER counts (not bytes), and they are
// hard: the last printed row is always a real row or the fold line that says
// where the rest went.
export const DIGEST_LINE_MAX = 120;    // chars in one digest/debt row
export const DIGEST_ROWS_MAX = 25;     // digest rows before the fold line
export const DELIVERY_CHAR_MAX = 3000; // the whole default (instruction-layer) stdout
// The note IS the request; the locator is only a hint for finding the file. A row
// therefore never squeezes the note below this, even when the locator cannot be
// compressed enough to keep the row at DIGEST_LINE_MAX.
export const NOTE_MIN_CHARS = 40;

// 8h: only ever decides whether `report`/`batches` label an aged open row as
// stale. It never decides whether an annotation may be delivered (v4 ruling 5).
export const DEFAULT_OPEN_TTL_MS = 8 * 60 * 60 * 1000;

export function openTtlMs(value, env = process.env) {
  const raw = value ?? env.ANNOTATE_OPEN_TTL_MS;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_OPEN_TTL_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`--open-ttl must be a non-negative number of ms (got ${JSON.stringify(raw)})`);
  return n;
}

// --- identity ------------------------------------------------------------------

const pad = (n, w = 2) => String(n).padStart(w, '0');

// Local time, so the id matches the clock a human reads on the wall (the ledger
// also carries epoch ms for anything that has to compare).
export function stamp(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export function hex4() {
  return randomBytes(2).toString('hex');
}

export const BATCH_ID_RE = /^[wb]-\d{8}-\d{6}-[0-9a-f]{4}$/;

export const isBatchId = (id) => typeof id === 'string' && BATCH_ID_RE.test(id);

// Ids become file names and are echoed by `--batch`, so a caller-supplied id that
// is not exactly this shape must never reach join(): "../../evil" is not a batch.
export function assertBatchId(id) {
  if (!isBatchId(id)) throw new Error(`bad batch id ${JSON.stringify(id)} (expected ${BATCH_ID_RE})`);
  return id;
}

// Issued ids live in a process-local set as well, so two calls in the same
// millisecond cannot return the same id even before either file exists. Write
// batches get no `.json`, so the disk check only applies to claim batches.
const issued = new Set();

export function newBatchId(inbox, prefix = 'b', ms = Date.now()) {
  for (let attempt = 0; attempt < 64; attempt++) {
    const id = `${prefix}-${stamp(ms)}-${hex4()}`;
    if (issued.has(id)) continue;
    if (prefix === 'b' && existsSync(batchPath(inbox, id))) continue;
    issued.add(id);
    return id;
  }
  throw new Error(`cannot mint a unique ${prefix}- batch id for ${inbox}`);
}

// --- files ---------------------------------------------------------------------

export function batchDir(inbox) {
  return pathsFor(inbox).batches;
}

export function batchPath(inbox, id) {
  assertBatchId(id);
  return join(batchDir(inbox), `${id}.json`);
}

// Fail-open by contract: absent, half-written or hand-edited JSON all read as
// "no ledger", never as a crash and never as "there is debt here" either.
export async function readBatch(inbox, id) {
  if (!isBatchId(id)) return null;
  try {
    const b = JSON.parse(await readFile(batchPath(inbox, id), 'utf8'));
    return b && typeof b === 'object' && !Array.isArray(b) ? b : null;
  } catch {
    return null;
  }
}

export async function writeBatch(inbox, batch) {
  await writeJsonAtomic(batchPath(inbox, batch.id), batch);
  return batch;
}

export async function listBatches(inbox, opts = {}) {
  const onWarn = typeof opts.onWarn === 'function' ? opts.onWarn : null;
  let names;
  try {
    names = await readdir(batchDir(inbox));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;               // skip our own .tmp-* files
    const id = name.slice(0, -'.json'.length);
    if (!isBatchId(id)) continue;
    const b = await readBatch(inbox, id);
    if (!b) {
      if (onWarn) onWarn(`账本 ${name} 读不动（非法 JSON 或不可读），已跳过`);
      continue;
    }
    out.push(b);
  }
  out.sort((a, b) => (b.at ?? 0) - (a.at ?? 0) || String(b.id).localeCompare(String(a.id)));
  return out;
}

// --- derived state (pure functions) --------------------------------------------

export function rollup(batch) {
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const item of batch?.items ?? []) if (item.status in counts) counts[item.status] += 1;
  return counts;
}

// The age at which an unanswered item stops being reported as "open" by
// report/batches. It is a label, not a permission.
export function expired(item, now, ttl = DEFAULT_OPEN_TTL_MS) {
  if (!(ttl > 0)) return false;                        // 0 = never age out
  const at = Number.isFinite(item?.claimedAt) ? item.claimedAt : null;
  return at !== null && now - at > ttl;
}

export function openCount(batch, { now = Date.now(), ttl = DEFAULT_OPEN_TTL_MS } = {}) {
  return (batch?.items ?? []).filter((i) => i.status === 'open' && !expired(i, now, ttl)).length;
}

// Report rows: `status` is what the ledger says, `display` is what a human should
// read today (an aged open row is shown as stale), and `unsettled` is what keeps
// the exit code at 3 — debt that is visible, never debt that blocks.
export function reportRows(batch, { now = Date.now(), ttl = DEFAULT_OPEN_TTL_MS } = {}) {
  return (batch?.items ?? []).map((item) => {
    const display = item.status === 'open' && expired(item, now, ttl) ? 'stale' : item.status;
    return {
      seq: item.seq,
      page: item.page ?? '',
      locator: locator(item),
      note: item.note ?? '',
      status: item.status,
      display,
      evidence: evidenceText(item),
      unsettled: display === 'open' || display === 'stale',
    };
  });
}

export function reportExitCode(batch, opts = {}) {
  return reportRows(batch, opts).some((r) => r.unsettled) ? 3 : 0;
}

// The census a human reads: an aged open item shows as `stale`, so the report
// table, its summary line and `batches` can never disagree. `rollup()` stays the
// raw status census (a pure function of the ledger); this one is the display view
// that --open-ttl is allowed to change (v4 ruling 5).
export function displayRollup(batch, { now = Date.now(), ttl = DEFAULT_OPEN_TTL_MS } = {}) {
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const row of reportRows(batch, { now, ttl })) if (row.display in counts) counts[row.display] += 1;
  return counts;
}

// `--open-ttl` and the six statuses are the whole classification; nothing here
// (and nowhere else) can make claim/watch refuse to deliver.

// --- formatting ----------------------------------------------------------------

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z') : '?');

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

export function noteHead(note) {
  const text = oneLine(note).split('\n')[0];
  if (!text) return '(无原话)';
  return text.length > NOTE_MAX ? `${text.slice(0, NOTE_MAX)}…` : text;
}

// Same fallback order as the overlay's pin list, but with the full source path:
// an inspector-less build has no line number, so component + selector comes next.
export function locator(item = {}) {
  const comp = item.component ? `<${item.component}>` : '';
  const source = item.source || '';
  const selector = item.selector || '';
  if (comp && source) return `${comp} ${source}`;
  if (source) return source;
  if (comp && selector) return `${comp} ${selector}`;
  if (selector) return selector;
  const rect = item.rect;
  if (rect && Number.isFinite(rect.w) && Number.isFinite(rect.h)) return `▦ region ${rect.w}×${rect.h}`;
  return '(无定位信息)';
}

// The delivery row has 120 characters for the *request*: a 90-char source path
// would eat it and leave the note as `就是这里的表头啊，要…`. So the locator drops
// the directory part (`src/views/x/Y.vue:64:9` -> `Y.vue:64:9`) and keeps the
// component name only when it is not already that file's stem
// (`<Upload> Upload.vue:12` -> `Upload.vue:12`). The full path is never lost: it
// is in the ledger and in processed.jsonl, which the [e:…] pointer names.
const basenameOf = (p) => {
  const s = String(p ?? '');
  const cut = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return cut === -1 ? s : s.slice(cut + 1);
};

export function shortLocator(item = {}) {
  const comp = item.component ? `<${item.component}>` : '';
  const source = item.source ? basenameOf(item.source) : '';
  const selector = item.selector || '';
  if (comp && source) return String(source).split('.')[0] === item.component ? source : `${comp} ${source}`;
  if (source) return source;
  if (comp && selector) return `${comp} ${selector}`;
  if (selector) return selector;
  const rect = item.rect;
  if (rect && Number.isFinite(rect.w) && Number.isFinite(rect.h)) return `▦ region ${rect.w}×${rect.h}`;
  return '(无定位信息)';
}

// A URL is one page; `#/route` is another. Query strings are dropped so ?tab=1
// and ?tab=2 do not each become a "page" (the per-item line still has the URL).
export function pageKey(url) {
  try {
    const u = new URL(url);
    if (u.hash && u.hash.startsWith('#/')) return u.hash.slice(1);
    return u.pathname || '/';
  } catch {
    return String(url ?? '');
  }
}

const shortW = (id) => (typeof id === 'string' && id.length >= 4 ? id.slice(-4) : '-');
const escapeCell = (s) => oneLine(s).replace(/\|/g, '\\|');

// One delivery row, hard-capped at `lineMax` characters — except for the note,
// which keeps at least NOTE_MIN_CHARS (its whole text when that is shorter). The
// note is the request and the locator is only a hint, so when the two do not both
// fit, the note wins: a row may pass lineMax rather than hide what was asked for.
// Only the note is ever rewritten, and only by a trailing `…` — the full text
// stays in processed.jsonl (the ledger keeps a 160-char head of it). The suffix
// (the [e:…] pointer) is never dropped: a truncated row must still say where to
// get the rest.
function fitRow(prefix, note, suffix, lineMax) {
  const text = oneLine(note) || '(无原话)';
  const room = Math.max(NOTE_MIN_CHARS, lineMax - prefix.length - suffix.length);
  return `${prefix}${text.length > room ? `${text.slice(0, room - 1)}…` : text}${suffix}`;
}

function evidenceText(item) {
  const last = Array.isArray(item.history) && item.history.length ? item.history[item.history.length - 1] : null;
  const what = oneLine(last?.note || last?.reason || '');
  if (item.status === 'stale' && last?.reason === 'ttl-expired') return `${iso(item.updatedAt)} 超时降级（ttl-expired）`;
  if (item.status === 'stale' && last?.reason === 'forced-past') return `${iso(item.updatedAt)} 带外跳过（forced-past）`;
  if (!what) return item.status === 'open' ? '—' : iso(item.updatedAt);
  return `${iso(item.updatedAt)} ${what}`;
}

function pageSummary(batch) {
  const pages = Array.isArray(batch?.pages) ? batch.pages : [];
  const shown = pages.slice(0, PAGES_LIMIT).map((p) => `${p.path} ×${p.count}`);
  if (pages.length > PAGES_LIMIT) shown.push(`… 其余 ${pages.length - PAGES_LIMIT} 个页面见 vibepin show --batch ${batch.id}`);
  return shown.join(' · ');
}

function writeBatchSummary(batch) {
  const list = Array.isArray(batch?.writeBatches) ? batch.writeBatches : [];
  const parts = list.map((w) => (w.id ? `${w.id}×${w.count}` : `无批号×${w.count}`));
  return `${list.length} 个（${parts.join(' · ') || '—'}）`;
}

// L1 only: the `[vibepin] …` lines. The debt block, the retrieval hint and the
// digest are composed by the caller (claim.js / formatInstructionLayer) in that
// order. `unsettled` is the carry-over row count claim.js already computed
// (null = not known here, i.e. `show` re-printing a ledger); the one-line debt
// note is only printed when the caller wants it — the v4.1 instruction layer
// leaves it out because the `## 未结清` block says the same thing when it matters.
export function formatHeader(batch, { inbox, now = Date.now(), unsettled = null, debtNote = true } = {}) {
  const lines = [];
  const session = batch.sessionId ?? '(none)';
  const pages = Array.isArray(batch.pages) ? batch.pages.length : 0;
  lines.push(`[vibepin] 批 ${batch.id} · ${batch.total} 条 · ${pages} 个页面 · 会话 ${session}`);
  const s = batch.sources ?? {};
  lines.push(`[vibepin] 来源 queue ${s.queue ?? 0} · inbox ${s.inbox ?? 0} · recovered ${s.recovered ?? 0} · 写入批 ${writeBatchSummary(batch)}`);
  if ((s.recovered ?? 0) > 0) lines.push(`[vibepin] 恢复 ${s.recovered} 条来自中断的认领（orphan .claiming）`);
  if (inbox) lines.push(`[vibepin] 账本 ${batchPath(inbox, batch.id)}`);
  lines.push(`[vibepin] 页面 ${pageSummary(batch) || '(无页面)'}`);
  lines.push(`[vibepin] 协议 ①逐条处理 ②每条 vibepin ack --batch ${batch.id} --seq <n> --status done --note "<file:line>" ③收尾 vibepin report --batch ${batch.id}`);
  if (debtNote) {
    lines.push('[vibepin] 欠债只记录不挡投递：'
      + (unsettled > 0 ? '更早批次的未结清项逐条列在下面（逐条 ack 结清）'
        : unsettled === 0 ? '本批没有更早批次的未结清项'
          : '结清用 vibepin ack，进度看 vibepin report'));
  }
  return lines.join('\n');
}

const foldMore = (batch, n) => `… 其余 ${n} 条见 vibepin show --batch ${batch.id}`;

// One row per item: `seq. [页面 ·] 定位 — 原话  [e:<processed 行号>/w:<短号>]`.
// `limit` / `lineMax` / `charBudget` are the delivery budget (Infinity = the raw
// form `show` re-prints); the fold line is reserved *before* a row is admitted, so
// a truncated digest never leaves the reader without the pointer to the rest.
export function formatDigest(batch, { pointers = true, status = false, limit = Infinity, lineMax = Infinity, charBudget = Infinity } = {}) {
  const items = Array.isArray(batch?.items) ? batch.items : [];
  const multi = (batch?.pages?.length ?? 0) > 1;
  const rows = [];
  let used = 0;
  for (const item of items) {
    if (rows.length >= limit) break;
    const page = multi ? `${item.page || '/'} · ` : '';
    const ptr = pointers ? `  [e:${item.evidence?.line ?? '?'}/w:${shortW(item.writeBatch)}]` : '';
    const st = status ? ` [${item.status}]` : '';
    const row = fitRow(`${item.seq}. ${page}${shortLocator(item)} — `, item.note, `${ptr}${st}`, lineMax);
    const next = used + (rows.length ? 1 : 0) + row.length;
    const rest = items.length - rows.length - 1;
    if (next + (rest > 0 ? foldMore(batch, rest).length + 1 : 0) > charBudget) break;
    rows.push(row);
    used = next;
  }
  const rest = items.length - rows.length;
  if (rest > 0) rows.push(foldMore(batch, rest));
  return rows.join('\n');
}

// The instruction layer is the whole default payload now, so the hint is where
// the evidence layer stays reachable: `--evidence` is the verbatim processed.jsonl
// line (the [e:…] pointer names its number), `--json` is the ledger file.
export function formatRetrievalHint(batch) {
  return [
    '[vibepin] 载荷 本批只投递"指令层"（页面 · 组件 · source:line · 原话）。某条的完整证据（selector/html/styles/rect/chain）按需取：',
    `[vibepin]   vibepin show --batch ${batch.id} --seq <n> --evidence   # 该条完整记录（= processed.jsonl:<行号>）`,
    `[vibepin]   vibepin show --batch ${batch.id} --json                 # 整批账本`,
  ].join('\n');
}

// The v4.1 default: header + retrieval hint + `## 未结清` + digest, and nothing
// else — no JSON is inlined. The whole block is sized to DELIVERY_CHAR_MAX, so the
// digest absorbs the leftovers: with the header/hint/debt a realistic delivery
// still prints a dozen rows before the fold line.
export function formatInstructionLayer(batch, { inbox, carry = [], now = Date.now() } = {}) {
  const head = formatHeader(batch, { inbox, now, debtNote: false });
  const hint = formatRetrievalHint(batch);
  const debt = formatUnsettled(carry);
  const parts = [head, hint, debt].filter((s) => s && s.trim());
  const fixed = parts.join('\n').length + 1;   // + the newline that joins the digest
  const digest = formatDigest(batch, {
    limit: DIGEST_ROWS_MAX,
    lineMax: DIGEST_LINE_MAX,
    charBudget: Math.max(0, DELIVERY_CHAR_MAX - fixed),
  });
  return [...parts, digest].filter((s) => s && s.trim()).join('\n');
}

const ageText = (ms) => {
  const min = Math.max(0, Math.round(ms / 60000));
  if (min < 90) return `${min} 分钟`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} 小时` : `${Math.round(h / 24)} 天`;
};

// The v4 replacement for the old gate: unpaid items from earlier batches of THIS
// session are listed, with one ack command each, right where a truncated stdout
// still shows them. `--all-done` and `--force` are deliberately not printed —
// teaching an agent to fake completion is worse than a missing ack. Rows come
// from carryOver().
export function formatUnsettled(rows, { limit = UNSETTLED_LIMIT, lineMax = DIGEST_LINE_MAX } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return '';
  const head = '## 未结清（更早批次，未重复投递；逐条结清用下面的 ack 命令）';
  const body = [];
  for (const r of list.slice(0, limit)) {
    // The row is bounded like a digest row: the note is the only thing that gets
    // an `…`, and the ledger keeps the whole text for `show`.
    const prefix = `- ${r.batchId}#${r.seq} [${r.status}] ${r.page ? `${r.page} ` : ''}${r.locator} — `;
    body.push(fitRow(prefix, r.note, `（认领于 ${iso(r.claimedAt)}，已 ${ageText(r.ageMs)}）`, lineMax));
    body.push(`  ack：vibepin ack --batch ${r.batchId} --seq ${r.seq} --status done --note "<file:line>"`);
  }
  if (list.length > limit) body.push(`… 其余 ${list.length - limit} 条见 vibepin show --batch ${list[0].batchId}`);
  return [head, ...body].join('\n');
}

// Rows for formatUnsettled: every not-yet-answered item of the same session's
// earlier batches, oldest first. Read-only and fail-open — a broken ledger
// directory leaves the delivery path completely unaffected.
function carryRows(batches, { sessionId = null, excludeId = null, limit = Infinity, now = Date.now() } = {}) {
  const rows = [];
  for (const batch of batches) {
    if (excludeId && batch.id === excludeId) continue;
    if ((batch.sessionId ?? null) !== (sessionId ?? null)) continue;
    for (const item of batch.items ?? []) {
      if (!UNSETTLED_STATUSES.includes(item.status)) continue;
      const claimedAt = Number.isFinite(item.claimedAt) ? item.claimedAt : batch.at;
      rows.push({
        batchId: batch.id,
        at: batch.at ?? 0,
        seq: item.seq,
        status: item.status,
        note: item.note ?? '',
        locator: shortLocator(item),
        page: item.page ?? '',
        claimedAt,
        ageMs: Number.isFinite(claimedAt) ? now - claimedAt : 0,
      });
    }
  }
  rows.sort((a, b) => (a.at - b.at) || (a.seq - b.seq));
  return Number.isFinite(limit) ? rows.slice(0, limit) : rows;
}

export async function carryOver(inbox, opts = {}) {
  return carryRows(await listBatches(inbox, { onWarn: opts.onWarn }), opts);
}

// The watcher's wake line is written from a synchronous callback, so it gets its
// own read path. Fail-open in the same way: an unreadable ledger directory is
// "no debt to show", never a different exit code.
export function carryOverSync(inbox, opts = {}) {
  const batches = [];
  let names;
  try {
    names = readdirSync(batchDir(inbox));
  } catch {
    return [];
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -'.json'.length);
    if (!isBatchId(id)) continue;
    try {
      const b = JSON.parse(readFileSync(join(batchDir(inbox), name), 'utf8'));
      if (b && typeof b === 'object' && !Array.isArray(b)) batches.push(b);
    } catch { /* skip: display only */ }
  }
  return carryRows(batches, opts);
}

// --- claim-side ledger creation --------------------------------------------------

// `items` are the annotations as delivered (in delivery order); `origins[i]` says
// which file the line was drained from and whether it came out of an interrupted
// claim's .claiming orphan. `evidenceBase` is the processed.jsonl line count
// taken BEFORE the drain, so evidence.line points at the archived copy of item i.
export async function createBatch({
  inbox, sessionId = null, items, origins = null, evidenceBase = 0,
  files = [], ttlMs = DEFAULT_OPEN_TTL_MS, now = Date.now(),
}) {
  const at = now;
  const id = newBatchId(inbox, 'b', at);
  const pages = new Map();
  const writers = new Map();
  const sources = { queue: 0, inbox: 0, recovered: 0 };

  const ledgerItems = items.map((item, i) => {
    const origin = origins?.[i] ?? {};
    const role = origin.role === 'queue' ? 'queue' : 'inbox';
    sources[role] += 1;
    if (origin.recovered) sources.recovered += 1;

    const url = typeof item.url === 'string' ? item.url : '';
    const key = pageKey(url);
    const page = pages.get(key) ?? { url, path: key, count: 0 };
    page.count += 1;
    pages.set(key, page);

    const writeBatch = typeof item.batch?.id === 'string' ? item.batch.id : null;
    writers.set(writeBatch, (writers.get(writeBatch) ?? 0) + 1);

    return {
      seq: i + 1,
      id: String(item.id ?? `${at}-${i}`),
      status: 'open',
      note: noteHead(item.note),
      kind: item.kind === 'region' ? 'region' : 'element',
      component: typeof item.component === 'string' && item.component ? item.component : null,
      source: typeof item.source === 'string' && item.source ? item.source : null,
      selector: typeof item.selector === 'string' && item.selector ? item.selector : null,
      rect: Number.isFinite(item.rect?.w) && Number.isFinite(item.rect?.h) ? { w: item.rect.w, h: item.rect.h } : null,
      url,
      page: key,
      writeBatch,
      sourceFile: origin.recovered ? 'recovered' : role,
      evidence: { file: 'processed.jsonl', line: evidenceBase + i + 1 },
      claimedAt: at,
      updatedAt: at,
      history: [{ at, by: 'claim', from: null, to: 'open' }],
    };
  });

  const batch = {
    v: LEDGER_VERSION,
    id,
    kind: 'claim',
    sessionId,
    at,
    closedAt: null,
    ttlMs,
    files: files.map((f) => ({ role: f.role, path: f.path })),
    sources,
    pages: [...pages.values()].sort((a, b) => b.count - a.count || a.path.localeCompare(b.path)),
    writeBatches: [...writers.entries()]
      .map(([wid, count]) => ({ id: wid, count }))
      .sort((a, b) => b.count - a.count || String(a.id ?? '').localeCompare(String(b.id ?? ''))),
    total: ledgerItems.length,
    items: ledgerItems,
    forced: [],
    rebuilt: false,
  };
  await writeBatch(inbox, batch);
  return batch;
}

// --- ack ------------------------------------------------------------------------

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// The only writer of item statuses. `seqs` is 1-based and matches the number the
// delivery header printed; null/undefined means "every open item" (--all-done).
// Rows already in the target status are left untouched and not counted, so a
// repeated ack is a no-op instead of a second history entry.
export async function ackItems(inbox, id, { seqs = null, status = 'done', note = null, reason = null, now = Date.now() } = {}) {
  assertBatchId(id);
  const batch = await readBatch(inbox, id);
  if (!batch) throw fail('unknown-batch', `unknown batch: ${id}`);
  if (!STATUSES.includes(status)) throw fail('bad-status', `--status must be one of ${STATUSES.join(' / ')} (got ${JSON.stringify(status)})`);

  // Which items comes first: an out-of-range --seq is a caller error about the
  // batch shape, and saying "batch b-… has 3 items" is more useful than
  // complaining about a missing --note for an item that does not exist.
  const total = batch.items?.length ?? 0;
  let targets;
  if (seqs === null || seqs === undefined) {
    targets = (batch.items ?? []).filter((i) => i.status === 'open');
  } else {
    const wanted = Array.isArray(seqs) ? seqs : [seqs];
    targets = [];
    for (const raw of wanted) {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > total) throw fail('unknown-seq', `batch ${id} has ${total} items (seq 1..${total})`);
      if (!targets.some((i) => i.seq === n)) targets.push((batch.items ?? []).find((i) => i.seq === n));
    }
  }

  const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const ackNote = text(note);
  const ackReason = text(reason);
  if (['done', 'open', 'stale'].includes(status) && !ackNote) throw fail('missing-note', `--note is required for ${status} (it becomes the 证据 column)`);
  if (['wontfix', 'blocked', 'deferred'].includes(status) && !ackReason) throw fail('missing-reason', `--reason is required for ${status}`);

  let updated = 0;
  for (const item of targets) {
    if (!item || item.status === status) continue;
    const entry = { at: now, by: 'ack', from: item.status, to: status };
    if (ackNote) entry.note = ackNote;
    if (ackReason) entry.reason = ackReason;
    item.history = [...(item.history ?? []), entry];
    item.status = status;
    item.updatedAt = now;
    updated += 1;
  }

  const counts = rollup(batch);
  // Closed means "nothing is unanswered any more". Age never closes a batch: TTL
  // is a report label, not a state transition (v4 ruling 5).
  if (counts.open === 0 && batch.closedAt == null && updated > 0) batch.closedAt = now;
  if (updated > 0) await writeBatch(inbox, batch);
  return { batch, updated, remaining: counts.open, closedAt: batch.closedAt };
}

// --- rebuild ---------------------------------------------------------------------

// The ledger is a projection, so it can be re-derived: claims.jsonl says which
// ids one claim delivered, processed.jsonl has the payloads. Everything is
// rebuilt as `stale` on purpose — guessing `open` would resurrect a debt nobody
// can see the end of, guessing `done` would fake completion.
export async function rebuildBatch(inbox, id) {
  if (!isBatchId(id)) return null;
  const { claims, processed } = pathsFor(inbox);
  let rec = null;
  for (const line of await readJsonlLines(claims)) {
    const r = parseItem(line);
    if (r && r.batchId === id && Array.isArray(r.ids)) rec = r;   // last one wins
  }
  if (!rec) return null;

  const byId = new Map();
  const lines = await readJsonlLines(processed);
  lines.forEach((line, idx) => {
    const it = parseItem(line);
    if (it && it.id !== undefined && !byId.has(String(it.id))) byId.set(String(it.id), { item: it, line: idx + 1 });
  });

  const at = Number.isFinite(rec.at) ? rec.at : Date.now();
  const items = rec.ids.map((rawId, i) => {
    const hit = byId.get(String(rawId));
    const item = hit?.item ?? {};
    return {
      seq: i + 1,
      id: String(rawId),
      status: 'stale',
      note: noteHead(item.note),
      kind: item.kind === 'region' ? 'region' : 'element',
      component: typeof item.component === 'string' && item.component ? item.component : null,
      source: typeof item.source === 'string' && item.source ? item.source : null,
      selector: typeof item.selector === 'string' && item.selector ? item.selector : null,
      rect: Number.isFinite(item.rect?.w) && Number.isFinite(item.rect?.h) ? { w: item.rect.w, h: item.rect.h } : null,
      url: typeof item.url === 'string' ? item.url : '',
      page: pageKey(typeof item.url === 'string' ? item.url : ''),
      writeBatch: typeof item.batch?.id === 'string' ? item.batch.id : null,
      sourceFile: 'inbox',
      evidence: { file: 'processed.jsonl', line: hit ? hit.line : null },
      claimedAt: at,
      updatedAt: at,
      history: [{ at, by: 'rebuild', from: null, to: 'stale', reason: 'ledger-missing' }],
    };
  });

  const pages = new Map();
  const writers = new Map();
  for (const item of items) {
    const page = pages.get(item.page) ?? { url: item.url, path: item.page, count: 0 };
    page.count += 1;
    pages.set(item.page, page);
    writers.set(item.writeBatch, (writers.get(item.writeBatch) ?? 0) + 1);
  }

  const batch = {
    v: LEDGER_VERSION,
    id,
    kind: 'claim',
    sessionId: rec.sessionId ?? null,
    at,
    closedAt: null,
    ttlMs: DEFAULT_OPEN_TTL_MS,
    files: [],
    sources: { queue: 0, inbox: items.length, recovered: 0 },
    pages: [...pages.values()].sort((a, b) => b.count - a.count || a.path.localeCompare(b.path)),
    writeBatches: [...writers.entries()]
      .map(([wid, count]) => ({ id: wid, count }))
      .sort((a, b) => b.count - a.count || String(a.id ?? '').localeCompare(String(b.id ?? ''))),
    total: items.length,
    items,
    forced: [],
    rebuilt: true,
  };
  await writeBatch(inbox, batch);
  return { batch, warning: `[vibepin] 账本缺失，已从 claims.jsonl + processed.jsonl 重建（所有项记 stale/ledger-missing）` };
}

// --- report ----------------------------------------------------------------------

export function formatReport(batch, { inbox, now = Date.now(), ttl = DEFAULT_OPEN_TTL_MS, json = false } = {}) {
  const rows = reportRows(batch, { now, ttl });
  const counts = displayRollup(batch, { now, ttl });
  if (json) {
    return JSON.stringify({
      batch: batch.id,
      sessionId: batch.sessionId ?? null,
      at: batch.at,
      total: batch.total,
      rollup: counts,
      rows: rows.map((r) => ({ seq: r.seq, page: r.page, locator: r.locator, note: r.note, status: r.status, display: r.display, evidence: r.evidence })),
    }, null, 2);
  }

  const out = [];
  out.push(`vibepin report — 批 ${batch.id}（会话 ${batch.sessionId ?? '(none)'} · ${iso(batch.at)} · ${batch.total} 条）`);
  if (inbox) out.push(`账本 ${batchPath(inbox, batch.id)}`);
  const unsettled = rows.filter((r) => r.unsettled);
  if (unsettled.length) {
    out.push('');
    out.push(`⚠ ${unsettled.length} 行未结清（seq ${unsettled.map((r) => r.seq).join(', ')}）—— 全部结清后本命令退出码才会变成 0`);
  }
  out.push('');
  out.push('| seq | 页面 | 组件 / source:line | 原话 | 状态 | 证据 |');
  out.push('| --- | --- | --- | --- | --- | --- |');
  for (const r of rows) {
    out.push(`| ${r.unsettled ? '!' : ''}${r.seq} | ${escapeCell(r.page)} | ${escapeCell(r.locator)} | ${escapeCell(r.note)} | ${r.display} | ${escapeCell(r.evidence)} |`);
  }
  out.push('');
  const lineCounts = STATUSES.map((s) => `${s} ${counts[s]}`).join(' · ');
  out.push(`${rows.length} 行（= total）· ${lineCounts}`);
  const evidenceLines = rows.map((r) => batch.items?.find((i) => i.seq === r.seq)?.evidence?.line).filter(Number.isFinite);
  if (evidenceLines.length) {
    const first = Math.min(...evidenceLines);
    const last = Math.max(...evidenceLines);
    out.push(`证据文件：processed.jsonl:${first}-${last} · 展开原始载荷：vibepin show --batch ${batch.id} --json`);
  }
  return out.join('\n');
}
