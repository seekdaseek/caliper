/**
 * caliper — backtesting across many symbols without leaking.
 *
 * There are three places a backtest of this shape leaks, and only one of them
 * is obvious.
 *
 *   1. Training on data that comes after the test set. Obvious, handled by a
 *      single global time cutoff shared by every symbol.
 *   2. Splitting at random. Two windows fifteen minutes apart are nearly the
 *      same observation, so a random split puts near-copies of the test set
 *      into training. Handled in model.mjs by splitting on time.
 *   3. Deriving the THRESHOLD from the whole tape. This one is easy to miss,
 *      because the threshold feels like part of the question rather than part
 *      of the model. It is not: a 90th percentile computed over the full tape
 *      encodes how loud the future was, and every label inherits that. The
 *      threshold is computed from training windows only.
 *
 * The states are symbol-relative by construction, so pooling every symbol into
 * one table is legitimate and is what gives thin symbols any support at all.
 */

import { toWindows, densify, thresholdFor, stateOf, WINDOW_MS } from "./features.mjs";
import { fit, forecastAll } from "./model.mjs";
import { skillScore, coverage, murphy, baseRate, meanBrier } from "./scoring.mjs";

/**
 * Label a single symbol either side of a cutoff, with the threshold taken
 * from the training side only.
 *
 * Returns null when the symbol has too little training history for a
 * percentile to mean anything. That is a refusal about the symbol, not about
 * the market.
 */
export function prepareSymbol(events, cutoff, opts = {}) {
  const { windowMs = WINDOW_MS, quantileQ = 0.9, minTrainWindows = 200, scheme = "fine" } = opts;
  // A bare number keeps the two-slice form: train before it, evaluate after.
  const { trainEndTs, evalStartTs, evalEndTs } =
    typeof cutoff === "number"
      ? { trainEndTs: cutoff, evalStartTs: cutoff, evalEndTs: Infinity }
      : cutoff;
  const cutoffTs = trainEndTs;
  const bySymbol = toWindows(events, windowMs);
  const symbol = events.length ? events[0].symbol : null;
  const raw = bySymbol.get(symbol);
  if (!raw || raw.length === 0) return null;

  const windows = densify(raw, windowMs);
  const train = windows.filter((w) => w.start < cutoffTs);
  const test = windows.filter((w) => w.start >= cutoffTs);
  if (train.length < minTrainWindows) {
    return { symbol, skipped: `only ${train.length} training windows, minimum is ${minTrainWindows}` };
  }

  const threshold = thresholdFor(train, quantileQ);
  if (threshold === null || threshold <= 0) {
    return { symbol, skipped: "training windows contain no volume, so no threshold exists" };
  }

  const label = (slice) => {
    const out = [];
    for (let i = 1; i < slice.length - 1; i++) {
      const state = stateOf(slice.slice(i - 1, i + 1), threshold, scheme);
      if (state === null) continue;
      out.push({ symbol, at: slice[i].start, state, outcome: slice[i + 1].usd > threshold ? 1 : 0 });
    }
    return out;
  };

  return {
    symbol,
    threshold,
    trainWindows: train.length,
    testWindows: test.length,
    trainPairs: label(train),
    // The first test window needs the one before it for state, so the boundary
    // window is included for context and its own label is produced by `label`.
    testPairs: label(
      windows.filter((w) => w.start >= evalStartTs - windowMs && w.start < evalEndTs)
    ),
  };
}

/**
 * Run the whole thing. `eventsBySymbol` is a Map of symbol to its events.
 */
/**
 * Two modes, and the distinction is the point.
 *
 *   validation  train on the first 70%, evaluate on 70-85%. Use this while
 *               changing anything, as often as you like.
 *   final       train on the first 85%, evaluate on the last 15%. Read once,
 *               at the end, and report whatever it says.
 *
 * Nothing enforces this but the person running it. The modes exist so that
 * "which slice did that number come from" always has an answer.
 */
export function runBacktest(eventsBySymbol, opts = {}) {
  const {
    minSupport = 30,
    scheme = "fine",
    mode = "validation",
    trainFraction = 0.7,
    validationFraction = 0.85,
  } = opts;

  let lo = Infinity;
  let hi = -Infinity;
  for (const events of eventsBySymbol.values()) {
    for (const e of events) {
      if (e.ts < lo) lo = e.ts;
      if (e.ts > hi) hi = e.ts;
    }
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    return { error: "no events", symbols: 0 };
  }
  const span = hi - lo;
  const trainEndTs = lo + span * (mode === "final" ? validationFraction : trainFraction);
  const evalStartTs = trainEndTs;
  const evalEndTs = mode === "final" ? Infinity : lo + span * validationFraction;
  const cutoffTs = trainEndTs;

  const trainPairs = [];
  const testPairs = [];
  const included = [];
  const skipped = [];
  for (const [symbol, events] of eventsBySymbol) {
    const prepared = prepareSymbol(events, { trainEndTs, evalStartTs, evalEndTs }, opts);
    if (!prepared) continue;
    if (prepared.skipped) {
      skipped.push({ symbol, reason: prepared.skipped });
      continue;
    }
    trainPairs.push(...prepared.trainPairs);
    testPairs.push(...prepared.testPairs);
    included.push({ symbol, threshold: prepared.threshold, trainWindows: prepared.trainWindows });
  }

  if (testPairs.length === 0) {
    return { error: "nothing to test on after the cutoff", cutoffTs, skipped: skipped.length };
  }

  const model = fit(trainPairs);
  const outcomes = testPairs.map((p) => p.outcome);
  const forecasts = forecastAll(model, testPairs.map((p) => p.state), {
    minSupport,
    symbols: testPairs.map((p) => p.symbol),
  });
  const m = murphy(forecasts, outcomes);

  return {
    mode,
    scheme,
    cutoffTs,
    evalEndTs,
    firstTs: lo,
    lastTs: hi,
    symbolsIncluded: included.length,
    symbolsSkipped: skipped.length,
    skippedExamples: skipped.slice(0, 5),
    trainPairs: trainPairs.length,
    testPairs: testPairs.length,
    states: model.states,
    trainBaseRate: model.baseRate,
    testBaseRate: baseRate(outcomes),
    skill: skillScore(forecasts, outcomes),
    coverage: coverage(forecasts),
    brierAnswered: meanBrier(forecasts, outcomes),
    reliability: m?.reliability ?? null,
    resolution: m?.resolution ?? null,
    residual: m?.residual ?? null,
    curve: m?.curve ?? [],
  };
}
