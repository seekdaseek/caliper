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
import { brier, baseRate, skillScore, coverage, murphy, isForecast } from "./scoring.mjs";

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
 */
export function tally(db, opts = {}) {
  const { since = 0, symbol = null } = opts;
  const rows = symbol
    ? db.prepare("SELECT * FROM forecasts WHERE settled_at IS NOT NULL AND window_start >= ? AND symbol = ? ORDER BY window_start").all(since, symbol)
    : db.prepare("SELECT * FROM forecasts WHERE settled_at IS NOT NULL AND window_start >= ? ORDER BY window_start").all(since);

  if (rows.length === 0) {
    return { settled: 0, pending: pendingCount(db), skill: null, reason: "nothing has settled yet" };
  }
  const forecasts = rows.map((r) => (r.p === null ? null : r.p));
  const outcomes = rows.map((r) => r.outcome);
  const m = murphy(forecasts, outcomes);
  const answered = rows.filter((r) => r.p !== null);

  return {
    settled: rows.length,
    pending: pendingCount(db),
    firstWindow: new Date(rows[0].window_start).toISOString(),
    lastWindow: new Date(rows[rows.length - 1].window_start).toISOString(),
    symbols: new Set(rows.map((r) => r.symbol)).size,
    baseRate: baseRate(outcomes),
    skill: skillScore(forecasts, outcomes),
    coverage: coverage(forecasts),
    brierAnswered: answered.length
      ? answered.reduce((s, r) => s + brier(r.p, r.outcome), 0) / answered.length
      : null,
    reliability: m?.reliability ?? null,
    resolution: m?.resolution ?? null,
    curve: m?.curve ?? [],
    declines: rows.length - answered.length,
  };
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
