/**
 * caliper miner — one answer.
 *
 * Kept as a pure function over a database handle, deliberately separate from
 * any transport. The payment rail already exists: AgentFeed serves paid x402
 * tools on Base today, so this becomes another tool there rather than a second
 * service with its own facilitator to keep alive.
 *
 * Every answer is SELF-DESCRIBING. It carries the exact question, the horizon,
 * the threshold and how the threshold was derived, the evidence state, and the
 * support behind it. An application should never have to read this source to
 * know what the number means, and a validator should never have to ask how to
 * settle it.
 */

import { toWindows, densify, thresholdFor, stateOf, WINDOW_MS } from "./features.mjs";
import { forecast } from "./model.mjs";
import { isForecast } from "./scoring.mjs";

export const QUESTION_ID = "liquidation-window-exceedance-v1";

/** The machine-readable spec. Publish this; it is the contract. */
export function questionSpec(opts = {}) {
  const { windowMs = WINDOW_MS, quantileQ = 0.9 } = opts;
  return {
    id: QUESTION_ID,
    ask: "Will this symbol's liquidation volume in the NEXT window exceed its own reference-period threshold?",
    windowSeconds: windowMs / 1000,
    thresholdRule: `the ${quantileQ * 100}th percentile of the symbol's own ${windowMs / 60000}-minute liquidation volume over the reference period`,
    answer: "a probability between 0 and 1, or a decline",
    settlement:
      "sum liquidation USD for the symbol over the next window from the exchange's public feed and compare to the stated threshold",
    settleable_by: "anyone subscribed to the same public liquidation stream",
    declines:
      "a decline is returned when the current state has too little history behind it; it is an answer, not an error",
  };
}

/**
 * Read the windows a symbol needs to be answered right now: enough history to
 * set a threshold, plus the last two windows for state.
 */
export function loadRecent(db, symbol, nowMs, opts = {}) {
  const { windowMs = WINDOW_MS, lookbackWindows = 2000 } = opts;
  const currentStart = Math.floor(nowMs / windowMs) * windowMs;
  const lastClosed = currentStart - windowMs;
  const from = lastClosed - (lookbackWindows - 1) * windowMs;

  const rows = db
    .prepare("SELECT ts, symbol, side, usd FROM liquidations WHERE symbol = ? AND ts >= ? AND ts < ? ORDER BY ts")
    .all(symbol, from, currentStart);

  // An empty result means the market was QUIET, not that data is missing.
  // Returning [] here would turn a calm period into a refusal, which is the
  // same mistake as dropping empty windows when building the tape. The frame
  // is built from the requested span, and liquidations fill it in.
  const raw = rows.length === 0 ? [] : (toWindows(rows, windowMs).get(symbol) ?? []);
  const byStart = new Map(raw.map((w) => [w.start, w]));
  const out = [];
  for (let t = from; t <= lastClosed; t += windowMs) {
    out.push(byStart.get(t) ?? { symbol, start: t, usd: 0, count: 0, buyUsd: 0, sellUsd: 0 });
  }
  return out;
}

/** Have we ever recorded this symbol at all? Cheap, and it changes the verdict. */
export function symbolKnown(db, symbol) {
  const row = db.prepare("SELECT 1 AS ok FROM liquidations WHERE symbol = ? LIMIT 1").get(symbol);
  return Boolean(row);
}

/**
 * Answer for one symbol. Never throws on a data problem; returns a decline
 * carrying the reason, because "I cannot answer" is a real answer and an
 * exception is not.
 */
export function answer(model, db, symbol, nowMs = Date.now(), opts = {}) {
  const {
    windowMs = WINDOW_MS,
    quantileQ = 0.9,
    minSupport = 30,
    minWindows = 200,
    // A threshold carried by the fitted model. Preferred when present: it is
    // the one the model was actually trained against, so answer and training
    // agree, and it removes a 2,000-window read from every request.
    threshold: givenThreshold = null,
  } = opts;
  const spec = questionSpec({ windowMs, quantileQ });
  const base = { question: spec, symbol, asOf: new Date(nowMs).toISOString() };

  const lookbackWindows = givenThreshold === null ? (opts.lookbackWindows ?? 2000) : 4;
  let windows;
  try {
    windows = loadRecent(db, symbol, nowMs, { ...opts, lookbackWindows });
  } catch (err) {
    return { ...base, evidence: "unmeasured", p: null, reason: `tape read failed: ${err.message}` };
  }

  // The frame is always full now, so length alone proves nothing. When the
  // threshold has to be recomputed, what matters is how many windows actually
  // carry volume: a percentile over a run of zeros is not a threshold.
  const withVolume = windows.filter((w) => w.usd > 0).length;

  // Order matters here. A symbol with a full frame and no volume anywhere is
  // ABSENT: we looked, and the world has none. A symbol with some volume but
  // not enough to set a percentile is UNMEASURED: our estimate would be the
  // thing that failed, not the market. Checking length first would have
  // collapsed the two and reported a real absence as our own failure.
  if (withVolume === 0 && givenThreshold === null) {
    // Three cases, and collapsing any two of them would be a lie.
    //
    //   never recorded    we do not cover this symbol. That is OUR gap, and we
    //                     cannot say whether the world has none. UNMEASURED.
    //   recorded, quiet   we do cover it and there is genuinely nothing.
    //                     ABSENT.
    //   some but thin     the market is there, our estimate is what fails.
    //                     UNMEASURED, handled below.
    let known;
    try {
      known = symbolKnown(db, symbol);
    } catch (err) {
      return { ...base, evidence: "unmeasured", p: null, reason: `coverage check failed: ${err.message}` };
    }
    return known
      ? {
          ...base,
          evidence: "absent",
          p: null,
          reason: "this symbol is covered and has recorded no liquidation volume, so there is no threshold to exceed",
        }
      : {
          ...base,
          evidence: "unmeasured",
          p: null,
          reason: "this symbol has never been recorded, so its absence of volume says nothing about the market",
        };
  }

  const needed = givenThreshold === null ? minWindows : 2;
  const have = givenThreshold === null ? withVolume : windows.length;
  if (have < needed) {
    return {
      ...base,
      evidence: "unmeasured",
      p: null,
      reason: `only ${have} windows of history for this symbol, minimum is ${needed}`,
    };
  }

  const threshold = givenThreshold ?? thresholdFor(windows, quantileQ);
  if (threshold === null || threshold <= 0) {
    return {
      ...base,
      evidence: "absent",
      p: null,
      reason: "this symbol has recorded no liquidation volume, so there is no threshold to exceed",
    };
  }

  const state = stateOf(windows.slice(-2), threshold);
  const f = forecast(model, state, { minSupport, symbol });
  const closed = windows[windows.length - 1];

  const out = {
    ...base,
    thresholdUsd: threshold,
    thresholdSource: givenThreshold === null ? "recomputed from recent history" : "the threshold this model was trained against",
    windowStart: new Date(closed.start).toISOString(),
    windowEnd: new Date(closed.start + windowMs).toISOString(),
    observed: { usd: closed.usd, events: closed.count, buyUsd: closed.buyUsd, sellUsd: closed.sellUsd },
    state,
    support: f.support,
    symbolSupport: f.symbolSupport ?? 0,
  };

  if (!isForecast(f.p)) {
    return { ...out, evidence: "unmeasured", p: null, reason: f.reason };
  }
  return {
    ...out,
    evidence: "measured",
    p: f.p,
    reason: null,
    basis:
      (f.symbolSupport ?? 0) > 0
        ? `${f.symbolSupport} occurrences of this state for this symbol, shrunk toward ${f.pooled.toFixed(4)} from ${f.support} across all symbols`
        : `empirical frequency over ${f.support} historical occurrences of this state, pooled across symbols`,
  };
}

/** Answer several symbols. One bad symbol never takes down the batch. */
export function answerMany(model, db, symbols, nowMs = Date.now(), opts = {}) {
  return symbols.map((s) => {
    try {
      return answer(model, db, s, nowMs, opts);
    } catch (err) {
      return {
        question: questionSpec(opts),
        symbol: s,
        asOf: new Date(nowMs).toISOString(),
        evidence: "unmeasured",
        p: null,
        reason: `unexpected failure: ${err.message}`,
      };
    }
  });
}
