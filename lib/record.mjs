/**
 * caliper — the public track record.
 *
 * A backtest is a claim about the past that the person making it also chose
 * how to compute. Everyone has one. This is the other thing: forecasts written
 * down BEFORE the window they describe, settled afterwards from the exchange's
 * own public feed, with every row kept so anyone can recompute the score
 * themselves and get the same answer.
 *
 * Three rules are enforced by the schema rather than by good intentions:
 *
 *   a forecast can only be written before its window opens
 *   a forecast can only be written once per symbol and window
 *   an outcome can only be settled once
 *
 * Nothing here can revise a prediction after the fact, which is the only
 * property that makes a record worth reading.
 */

import { WINDOW_MS } from "./features.mjs";
import { brier, isForecast } from "./scoring.mjs";

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS forecasts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  made_at INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  window_end INTEGER NOT NULL,
  threshold_usd REAL NOT NULL,
  p REAL,
  evidence TEXT NOT NULL,
  support INTEGER,
  symbol_support INTEGER,
  state TEXT,
  model_fitted_at TEXT,
  settled_at INTEGER,
  observed_usd REAL,
  outcome INTEGER,
  UNIQUE(symbol, window_start)
);
CREATE INDEX IF NOT EXISTS idx_fc_window ON forecasts(window_start);
CREATE INDEX IF NOT EXISTS idx_fc_unsettled ON forecasts(settled_at) WHERE settled_at IS NULL;
`;

export function initLog(db) {
  db.exec(SCHEMA);
  return db;
}

export class RecordError extends Error {}

/**
 * Write a forecast for the window that has not started yet.
 *
 * Refuses a window that has already opened. Without that, the record would be
 * indistinguishable from writing down what already happened, and worth exactly
 * as much.
 */
export function recordForecast(db, answer, nowMs = Date.now(), opts = {}) {
  const { windowMs = WINDOW_MS } = opts;
  const currentStart = Math.floor(nowMs / windowMs) * windowMs;
  const windowStart = currentStart + windowMs;

  if (!answer || !answer.symbol) throw new RecordError("an answer without a symbol cannot be recorded");
  if (windowStart <= nowMs) throw new RecordError("refusing to record a forecast for a window that has already opened");

  const row = {
    made_at: nowMs,
    symbol: answer.symbol,
    window_start: windowStart,
    window_end: windowStart + windowMs,
    threshold_usd: answer.thresholdUsd ?? 0,
    p: isForecast(answer.p) ? answer.p : null,
    evidence: answer.evidence,
    support: answer.support ?? 0,
    symbol_support: answer.symbolSupport ?? 0,
    state: answer.state ?? null,
    model_fitted_at: answer.modelFittedAt ?? null,
  };

  try {
    db.prepare(
      `INSERT INTO forecasts (made_at, symbol, window_start, window_end, threshold_usd, p,
        evidence, support, symbol_support, state, model_fitted_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      row.made_at, row.symbol, row.window_start, row.window_end, row.threshold_usd,
      row.p, row.evidence, row.support, row.symbol_support, row.state, row.model_fitted_at
    );
    return { written: true, ...row };
  } catch (err) {
    if (/UNIQUE/i.test(err.message)) {
      return { written: false, reason: "already forecast for this symbol and window", ...row };
    }
    throw err;
  }
}

/**
 * Settle every forecast whose window has closed, from the tape.
 *
 * The UPDATE carries `settled_at IS NULL`, so a row can never be settled
 * twice, and an outcome once written is never revised.
 */
export function settleDue(db, tapeDb, nowMs = Date.now(), opts = {}) {
  const { windowMs = WINDOW_MS, graceMs = 60_000 } = opts;
  const cutoff = nowMs - graceMs;
  const due = db
    .prepare("SELECT id, symbol, window_start, window_end, threshold_usd FROM forecasts WHERE settled_at IS NULL AND window_end <= ? ORDER BY window_start")
    .all(cutoff);

  const sum = tapeDb.prepare(
    "SELECT COALESCE(SUM(usd), 0) AS usd FROM liquidations WHERE symbol = ? AND ts >= ? AND ts < ?"
  );
  const mark = db.prepare(
    "UPDATE forecasts SET settled_at = ?, observed_usd = ?, outcome = ? WHERE id = ? AND settled_at IS NULL"
  );

  let settled = 0;
  for (const row of due) {
    const observed = sum.get(row.symbol, row.window_start, row.window_end)?.usd ?? 0;
    const outcome = observed > row.threshold_usd ? 1 : 0;
    const res = mark.run(nowMs, observed, outcome, row.id);
    if (res.changes > 0) settled++;
  }
  return { due: due.length, settled };
}

/**
 * Score the record. Everything here is recomputable from the rows themselves,
 * which is the point: publish the log and anyone gets the same numbers.
 *
 * Streamed, never materialised. This used to be SELECT * with every settled
 * row held in memory; at 1.2M rows that is ~1.7 GB, most of it the evidence
 * text the score never looks at, and it was getting the box OOM-killed every
 * fifteen minutes. Only the four columns the score actually uses are read, one
 * row at a time, in two passes: the second needs the base rate and so cannot
 * begin until the first has finished counting.
 *
 * Every sum below is accumulated in the SAME ORDER as before. Floating-point
 * addition is not associative, so a different row order is a different last
 * bit. idx_fc_window is (window_start, rowid) and id IS rowid, which makes
 * `ORDER BY window_start, id` exactly the order the old SELECT * already got
 * from that index -- stated explicitly here so a future query plan cannot
 * quietly reorder the arithmetic.
 */
export function tally(db, opts = {}) {
  const { since = 0, symbol = null } = opts;
  const sql = symbol
    ? "SELECT p, outcome, symbol, window_start FROM forecasts WHERE settled_at IS NOT NULL AND window_start >= ? AND symbol = ? ORDER BY window_start, id"
    : "SELECT p, outcome, symbol, window_start FROM forecasts WHERE settled_at IS NOT NULL AND window_start >= ? ORDER BY window_start, id";
  const args = symbol ? [since, symbol] : [since];
  const scan = () => db.prepare(sql).iterate(...args);

  // Pass one: everything independent of the base rate, which includes the
  // whole Murphy decomposition -- its buckets depend only on the pairs.
  const BINS = 10;
  const buckets = new Map();
  const symbols = new Set();
  let n = 0;
  let sumOutcome = 0;    // outcomes are 0/1, so this stays an exact integer
  let answered = 0;      // p !== null, matching the old `answered` filter
  let forecasts = 0;     // isForecast(p), which is what coverage counts
  let pairN = 0;
  let pairSumO = 0;
  let firstWindow = null;
  let lastWindow = null;

  for (const r of scan()) {
    if (n === 0) firstWindow = r.window_start;
    lastWindow = r.window_start;
    n++;
    sumOutcome += r.outcome;
    symbols.add(r.symbol);
    if (r.p !== null) answered++;
    if (isForecast(r.p)) {
      forecasts++;
      const p = r.p < 0 ? 0 : r.p > 1 ? 1 : r.p; // clamp01, as murphy() does
      pairN++;
      pairSumO += r.outcome;
      const k = Math.min(BINS - 1, Math.floor(p * BINS));
      let b = buckets.get(k);
      if (!b) { b = { n: 0, sumP: 0, sumO: 0 }; buckets.set(k, b); }
      b.n++;
      b.sumP += p;
      b.sumO += r.outcome;
    }
  }

  if (n === 0) {
    return { settled: 0, pending: pendingCount(db), skill: null, reason: "nothing has settled yet" };
  }

  const c = sumOutcome / n; // baseRate

  // Pass two: the sums that need the base rate. brier() still throws on a
  // non-null p outside [0,1], exactly as it did before.
  let refSum = 0;        // referenceBrier
  let adjSum = 0;        // coverageAdjustedBrier, declines charged the reference
  let answeredBrier = 0;
  for (const r of scan()) {
    const o = r.outcome;
    refSum += (c - o) ** 2;
    adjSum += isForecast(r.p) ? brier(r.p, o) : (c - o) ** 2;
    if (r.p !== null) answeredBrier += brier(r.p, o);
  }
  const ref = refSum / n;
  const m = murphyFrom(buckets, pairN, pairSumO);

  return {
    settled: n,
    pending: pendingCount(db),
    firstWindow: new Date(firstWindow).toISOString(),
    lastWindow: new Date(lastWindow).toISOString(),
    symbols: symbols.size,
    baseRate: c,
    // ref === 0 means every outcome was identical; no skill is measurable.
    skill: ref === 0 ? null : 1 - (adjSum / n) / ref,
    coverage: forecasts / n,
    brierAnswered: answered ? answeredBrier / answered : null,
    reliability: m?.reliability ?? null,
    resolution: m?.resolution ?? null,
    curve: m?.curve ?? [],
    declines: n - answered,
  };
}

/** Reliability, resolution and the calibration curve, from streamed bucket totals. */
function murphyFrom(buckets, n, sumO) {
  if (n === 0) return null;
  const cbar = sumO / n;
  let reliability = 0;
  let resolution = 0;
  const curve = [];
  for (const [k, b] of [...buckets.entries()].sort((a, z) => a[0] - z[0])) {
    const pk = b.sumP / b.n;
    const ok = b.sumO / b.n;
    reliability += (b.n * (pk - ok) ** 2) / n;
    resolution += (b.n * (ok - cbar) ** 2) / n;
    curve.push({ bin: k, n: b.n, meanForecast: pk, observedRate: ok });
  }
  return { reliability, resolution, curve };
}

function pendingCount(db) {
  return db.prepare("SELECT COUNT(*) AS n FROM forecasts WHERE settled_at IS NULL").get()?.n ?? 0;
}

/** The raw rows, so the score above can be checked rather than believed. */
export function exportRows(db, limit = 1000, offset = 0) {
  return db
    .prepare("SELECT * FROM forecasts ORDER BY window_start DESC LIMIT ? OFFSET ?")
    .all(limit, offset);
}
