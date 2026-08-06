/**
 * caliper miner — the forecaster.
 *
 * Deliberately not a black box. Caliper scores calibration, and an empirical
 * conditional frequency is calibrated by construction: if you say 12% because
 * 12% of the matching historical states resolved positive, then over enough
 * questions you are right 12% of the time. A model that cannot be gamed by its
 * own author is a reasonable starting point for a network that scores gaming
 * resistance.
 *
 * The part that matters more than the model: it can refuse. A state with too
 * little history behind it returns a decline, not a guess. Caliper charges a
 * decline the reference score, so refusing costs the miner exactly what
 * knowing nothing is worth, and no more.
 */

import { DECLINED } from "./scoring.mjs";

export const DEFAULT_MIN_SUPPORT = 30;

/**
 * Build the table from labelled pairs.
 *
 * Laplace smoothing pulls tiny cells toward the base rate rather than letting
 * three observations declare 100%. It is not a substitute for the support
 * rule; both are needed, because smoothing hides thin evidence while the
 * support rule refuses to trade on it.
 */
export function fit(pairs, opts = {}) {
  const { alpha = 1, shrinkage = 50 } = opts;
  const byState = new Map();
  const bySymbolState = new Map();
  let positives = 0;
  for (const p of pairs) {
    if (!byState.has(p.state)) byState.set(p.state, { n: 0, k: 0 });
    const c = byState.get(p.state);
    c.n += 1;
    c.k += p.outcome;
    positives += p.outcome;

    if (p.symbol) {
      const key = `${p.symbol}\u0000${p.state}`;
      if (!bySymbolState.has(key)) bySymbolState.set(key, { n: 0, k: 0 });
      const sc = bySymbolState.get(key);
      sc.n += 1;
      sc.k += p.outcome;
    }
  }
  const base = pairs.length === 0 ? null : positives / pairs.length;
  return {
    baseRate: base,
    trainedOn: pairs.length,
    states: byState.size,
    symbolStates: bySymbolState.size,
    alpha,
    shrinkage,
    cell(state) {
      return byState.get(state) ?? { n: 0, k: 0 };
    },
    symbolCell(symbol, state) {
      return bySymbolState.get(`${symbol}\u0000${state}`) ?? { n: 0, k: 0 };
    },
    stateKeys() {
      return [...byState.keys()];
    },
    symbolStateKeys() {
      return [...bySymbolState.keys()];
    },
  };
}

/**
 * Serialise a fitted model.
 *
 * The table is tiny — around a hundred states — so the whole thing is a small
 * JSON file. That matters for more than speed: fitting reads the entire tape
 * and takes tens of seconds, which is impossible inside a request, and a model
 * you can open and read is one an application can audit without asking you
 * anything.
 */
export function toJSON(model, meta = {}) {
  const states = {};
  for (const key of model.stateKeys()) {
    const c = model.cell(key);
    states[key] = [c.n, c.k];
  }
  const symbolStates = {};
  for (const key of model.symbolStateKeys?.() ?? []) {
    const [symbol, state] = key.split("\u0000");
    const c = model.symbolCell(symbol, state);
    // Only carry cells with enough behind them to move a forecast at all.
    // Below the shrinkage weight the pooled estimate dominates anyway, and
    // shipping them would triple the file for no change in any answer.
    if (c.n < (model.shrinkage ?? 50) / 5) continue;
    (symbolStates[symbol] ??= {})[state] = [c.n, c.k];
  }
  return {
    format: "caliper-model-v2",
    baseRate: model.baseRate,
    alpha: model.alpha,
    shrinkage: model.shrinkage,
    trainedOn: model.trainedOn,
    states,
    symbolStates,
    ...meta,
  };
}

/** Rebuild a model from its JSON. Refuses an unknown format rather than guessing. */
export function fromJSON(obj) {
  const known = ["caliper-model-v1", "caliper-model-v2"];
  if (!obj || !known.includes(obj.format)) {
    throw new Error(`unrecognised model format: ${obj?.format}`);
  }
  const cells = new Map(Object.entries(obj.states).map(([k, [n, kk]]) => [k, { n, k: kk }]));
  const symCells = new Map();
  for (const [symbol, states] of Object.entries(obj.symbolStates ?? {})) {
    for (const [state, [n, kk]] of Object.entries(states)) {
      symCells.set(`${symbol}\u0000${state}`, { n, k: kk });
    }
  }
  return {
    baseRate: obj.baseRate,
    trainedOn: obj.trainedOn,
    states: cells.size,
    symbolStates: symCells.size,
    alpha: obj.alpha ?? 1,
    shrinkage: obj.shrinkage ?? 50,
    fittedAt: obj.fittedAt ?? null,
    cell: (state) => cells.get(state) ?? { n: 0, k: 0 },
    symbolCell: (symbol, state) => symCells.get(`${symbol}\u0000${state}`) ?? { n: 0, k: 0 },
    stateKeys: () => [...cells.keys()],
    symbolStateKeys: () => [...symCells.keys()],
  };
}

/**
 * Forecast for one state.
 *
 * Returns a probability, or a decline with the reason attached. The reason
 * travels with the answer because a consumer deciding whether to act needs to
 * know the difference between "unlikely" and "I have never seen this".
 */
export function forecast(model, state, opts = {}) {
  const { minSupport = DEFAULT_MIN_SUPPORT, symbol = null } = opts;
  if (model.baseRate === null) {
    return { p: DECLINED, support: 0, reason: "model has no training data" };
  }
  if (state === null) {
    return { p: DECLINED, support: 0, reason: "state could not be computed for this window" };
  }
  const pooledCell = model.cell(state);
  if (pooledCell.n < minSupport) {
    return {
      p: DECLINED,
      support: pooledCell.n,
      reason: `only ${pooledCell.n} historical observations of this state, minimum is ${minSupport}`,
    };
  }

  const a = model.alpha;
  const pooled = (pooledCell.k + a * model.baseRate) / (pooledCell.n + a);

  // Hierarchical shrinkage.
  //
  // Pooling every symbol into one table is what gives thin symbols any support
  // at all, but it also means two symbols in the same state get the same
  // answer no matter how differently they actually behave. Estimating each
  // symbol separately fixes that and breaks the first problem.
  //
  // So: use the symbol's own record, pulled toward the pooled estimate in
  // proportion to how little of it there is. With no symbol history this
  // reduces exactly to the pooled number, and with a lot it converges on the
  // symbol's own rate. It cannot be worse than pooling, which is the point.
  const m = model.shrinkage ?? 0;
  const symCell = symbol && model.symbolCell ? model.symbolCell(symbol, state) : { n: 0, k: 0 };
  if (m <= 0 || symCell.n === 0) {
    return { p: pooled, support: pooledCell.n, symbolSupport: symCell.n, pooled, reason: null };
  }
  const p = (symCell.k + m * pooled) / (symCell.n + m);
  return {
    p,
    support: pooledCell.n,
    symbolSupport: symCell.n,
    pooled,
    shrunkBy: m / (symCell.n + m),
    reason: null,
  };
}

/** Forecast a batch, preserving order and returning bare probabilities or nulls. */
export function forecastAll(model, states, opts = {}) {
  const symbols = opts.symbols ?? null;
  return states.map((s, i) =>
    forecast(model, s, symbols ? { ...opts, symbol: symbols[i] } : opts).p
  );
}

/**
 * Split pairs by time so a backtest cannot see its own future.
 *
 * Splitting at random would leak: two windows fifteen minutes apart are almost
 * the same observation, so a random split puts near-copies of the test set
 * into training and reports a score the live miner will never reproduce.
 */
export function splitByTime(pairs, trainFraction = 0.75) {
  if (pairs.length === 0) return { train: [], test: [], cutoff: null };
  const sorted = [...pairs].sort((a, b) => a.at - b.at);
  const idx = Math.floor(sorted.length * trainFraction);
  const cutoff = sorted[idx]?.at ?? null;
  return {
    train: sorted.filter((p) => p.at < cutoff),
    test: sorted.filter((p) => p.at >= cutoff),
    cutoff,
  };
}
